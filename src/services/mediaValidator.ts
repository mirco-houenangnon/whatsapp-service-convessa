/**
 * mediaValidator.ts — Validation des médias selon les contraintes WhatsApp.
 *
 * Limites officielles WhatsApp :
 *   Image    : JPEG, PNG                         → max 5 MB
 *   Vidéo    : MP4 (H.264 + AAC)                → max 16 MB
 *   Audio    : MP3, MP4 audio, OGG (Opus)        → max 16 MB
 *   Document : PDF, DOCX, XLSX, PPTX, ZIP, etc.  → max 100 MB
 */

import type { MediaType } from '../db/MessageQueue.js'

export interface MediaValidationError {
    code:    string
    message: string
}

// ── Contraintes par type ───────────────────────────────────────────────────────

const MEDIA_RULES: Record<MediaType, {
    maxBytes: number
    mimes:    string[]
    label:    string
}> = {
    image: {
        maxBytes: 5 * 1024 * 1024,   // 5 MB
        mimes:    ['image/jpeg', 'image/jpg', 'image/png'],
        label:    'Image (JPEG, PNG — max 5 MB)',
    },
    video: {
        maxBytes: 16 * 1024 * 1024,  // 16 MB
        mimes:    ['video/mp4'],
        label:    'Vidéo MP4 (H.264 + AAC — max 16 MB)',
    },
    audio: {
        maxBytes: 16 * 1024 * 1024,  // 16 MB
        mimes:    ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/ogg; codecs=opus'],
        label:    'Audio MP3, M4A ou OGG/Opus (max 16 MB)',
    },
    document: {
        maxBytes: 100 * 1024 * 1024, // 100 MB
        mimes:    [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/zip',
            'application/x-zip-compressed',
            'text/plain',
            'text/csv',
        ],
        label:    'Document PDF, Word, Excel, PowerPoint, ZIP, TXT (max 100 MB)',
    },
}

export function validateMedia(
    type:     MediaType,
    mime:     string,
    base64?:  string,
    url?:     string,
): MediaValidationError | null {

    // Doit avoir soit une URL soit un base64
    if (!url && !base64) {
        return {
            code:    'MEDIA_SOURCE_MISSING',
            message: "Le média doit fournir soit 'media.url' soit 'media.base64'",
        }
    }

    const rules = MEDIA_RULES[type]
    if (!rules) {
        return {
            code:    'MEDIA_TYPE_INVALID',
            message: `Type de média invalide. Valeurs acceptées : image, video, audio, document`,
        }
    }

    // Validation du MIME
    const normalizedMime = mime.toLowerCase().split(';')[0]?.trim() ?? ''
    const mimeValid = rules.mimes.some(m => m.split(';')[0]?.trim() === normalizedMime)
    if (!mimeValid) {
        return {
            code:    'MEDIA_MIME_INVALID',
            message: `Type MIME '${mime}' non accepté pour ${type}. Formats supportés : ${rules.mimes.join(', ')}`,
        }
    }

    // Validation de la taille si base64 fourni
    if (base64) {
        // Taille réelle = base64.length * 3/4 (approximation)
        const estimatedBytes = Math.floor(base64.length * 0.75)
        if (estimatedBytes > rules.maxBytes) {
            const maxMb = rules.maxBytes / (1024 * 1024)
            return {
                code:    'MEDIA_TOO_LARGE',
                message: `Fichier trop volumineux pour un ${type} WhatsApp (max ${maxMb} MB)`,
            }
        }
    }

    return null
}

export function getMediaRules(): Record<string, { maxMb: number; formats: string }> {
    const result: Record<string, { maxMb: number; formats: string }> = {}
    for (const [type, rules] of Object.entries(MEDIA_RULES)) {
        result[type] = {
            maxMb:   rules.maxBytes / (1024 * 1024),
            formats: rules.label,
        }
    }
    return result
}
