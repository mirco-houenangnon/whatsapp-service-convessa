/**
 * phoneUtils.ts — Normalisation des numéros de téléphone pour WhatsApp.
 *
 * WhatsApp attend le format E.164 sans le + :
 *   indicatif pays + numéro local sans zéro de tête
 *
 * Exemples attendus :
 *   +229 51 99 93 58      →  22951999358
 *   +229 01 51 99 93 58   →  22951999358  (01 = préfixe opérateur béninois, à retirer)
 *   0151999358            →  22951999358  (numéro local béninois avec 01, +229 déduit)
 *   51999358              →  22951999358  (numéro béninois nu, +229 déduit)
 *   +22951999358          →  22951999358  (déjà au bon format)
 *   +33 6 12 34 56 78     →  33612345678
 *   06 12 34 56 78        →  612345678    (sans pays → on ne peut pas deviner l'indicatif)
 *
 * IMPORTANT : pour les numéros locaux sans indicatif, le frontend doit utiliser
 * PhoneInput (react-phone-number-input) qui force la saisie E.164 complète.
 * Cette fonction est le dernier filet de sécurité côté backend.
 *
 * ── Cas particulier Bénin ─────────────────────────────────────────────────────
 * L'ancien réseau béninois utilisait un préfixe "01" devant les numéros à 8 chiffres,
 * donnant 10 chiffres locaux (01XXXXXXXX). Avec le nouveau plan de numérotation,
 * les numéros sont à 8 chiffres (XXXXXXXX). WhatsApp n'accepte que 229XXXXXXXX (11 chiffres).
 *
 * Règle : si après l'indicatif 229 on trouve "01" suivi de 8 chiffres → retirer "01".
 * Ex: 229 01 51999358 (12 chiffres) → 229 51999358 (11 chiffres) ✓
 */

/**
 * Règles pays : indicatif → longueur attendue du numéro LOCAL (sans indicatif, sans zéro).
 * Utilisé pour détecter et supprimer les zéros/préfixes de tête erronés.
 */
const COUNTRY_RULES: Record<string, { localLength: number; stripPrefixes?: string[] }> = {
  '229': { localLength: 8,  stripPrefixes: ['01'] }, // Bénin — ancien préfixe opérateur 01
  '225': { localLength: 10 },                         // Côte d'Ivoire
  '221': { localLength: 9  },                         // Sénégal
  '226': { localLength: 8  },                         // Burkina Faso
  '227': { localLength: 8  },                         // Niger
  '228': { localLength: 8  },                         // Togo
  '237': { localLength: 9  },                         // Cameroun
  '224': { localLength: 9  },                         // Guinée
  '223': { localLength: 8  },                         // Mali
  '212': { localLength: 9  },                         // Maroc
  '33':  { localLength: 9  },                         // France
  '32':  { localLength: 9  },                         // Belgique
  '1':   { localLength: 10 },                         // USA/Canada
  '44':  { localLength: 10 },                         // Royaume-Uni
}

/**
 * Normalise un numéro de téléphone vers le format attendu par WhatsApp :
 * chiffres purs, sans +, sans zéro de tête local, sans préfixes opérateurs.
 *
 * @param raw - Numéro brut saisi par l'utilisateur (n'importe quel format)
 * @returns Numéro nettoyé prêt à être utilisé comme JID WhatsApp (sans @s.whatsapp.net)
 */
export function normalizePhone(raw: string): string {
    // 1. Retirer tout sauf les chiffres et le + en début
    const stripped = raw.trim().replace(/[\s\-().]/g, '')

    // 2. Retirer le + initial
    const digits = stripped.replace(/^\+/, '')

    // 3. Trouver l'indicatif pays correspondant (du plus long au plus court)
    const sortedCodes = Object.keys(COUNTRY_RULES).sort((a, b) => b.length - a.length)
    for (const code of sortedCodes) {
        if (digits.startsWith(code)) {
            const rule = COUNTRY_RULES[code]!
            let local = digits.slice(code.length) // partie après l'indicatif

            // 4a. Supprimer les préfixes opérateurs connus (ex: "01" béninois)
            if (rule.stripPrefixes) {
                for (const prefix of rule.stripPrefixes) {
                    if (local.startsWith(prefix) && local.length === prefix.length + rule.localLength) {
                        local = local.slice(prefix.length)
                        break
                    }
                }
            }

            // 4b. Supprimer le zéro de tête local si le numéro est trop long
            if (local.startsWith('0') && local.length === rule.localLength + 1) {
                local = local.slice(1)
            }

            return code + local
        }
    }

    // 5. Pas d'indicatif connu détecté — retirer juste le zéro de tête s'il existe
    //    (numéro local sans indicatif — le frontend doit envoyer E.164)
    if (digits.startsWith('0')) {
        return digits.slice(1)
    }

    return digits
}

/**
 * Convertit un numéro normalisé en JID WhatsApp complet.
 */
export function toWhatsAppJid(phone: string): string {
    return `${normalizePhone(phone)}@s.whatsapp.net`
}

/**
 * Convertit un numéro déjà normalisé (format WhatsApp, ex: "22951999358")
 * vers le format E.164 attendu par Firebase Auth (ex: "+2290151999358").
 *
 * Pourquoi c'est nécessaire : WhatsApp accepte les numéros béninois au format
 * "court" (préfixe opérateur "01" retiré), mais la validation libphonenumber
 * utilisée par Firebase Auth ne connaît pas le nouveau plan de numérotation à
 * 8 chiffres et rejette ces numéros comme trop courts (TOO_SHORT /
 * auth/invalid-phone-number). Firebase a donc besoin qu'on lui réinjecte le
 * préfixe opérateur qui avait été retiré pour WhatsApp.
 *
 * @param normalizedPhone - Numéro déjà passé par normalizePhone() (sans +)
 * @returns Numéro au format E.164 (avec +) prêt à être envoyé à Firebase
 */
export function toFirebaseE164(normalizedPhone: string): string {
    const sortedCodes = Object.keys(COUNTRY_RULES).sort((a, b) => b.length - a.length)

    for (const code of sortedCodes) {
        if (normalizedPhone.startsWith(code)) {
            const rule  = COUNTRY_RULES[code]!
            const local = normalizedPhone.slice(code.length)

            // Si un préfixe opérateur a été retiré pour WhatsApp (ex: "01" béninois)
            // et que le numéro local a bien la longueur "courte" attendue,
            // on le réinjecte pour satisfaire la validation Firebase.
            if (rule.stripPrefixes && local.length === rule.localLength) {
                return `+${code}${rule.stripPrefixes[0]}${local}`
            }

            return `+${normalizedPhone}`
        }
    }

    return `+${normalizedPhone}`
}