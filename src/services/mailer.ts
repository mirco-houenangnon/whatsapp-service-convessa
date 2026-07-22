/**
 * mailer.ts — Envoi d'alertes e-mail via nodemailer.
 * Utilisé uniquement lors d'une déconnexion définitive du numéro administrateur.
 * Une seule tentative par événement — l'échec est logué mais ne bloque pas le service.
 */

import nodemailer from 'nodemailer'
import { logger } from './logger.js'
import type { AppConfig } from '../config.js'

export interface AlertDetails {
    phone:      string   // Numéro masqué du compte déconnecté
    reason:     string   // Raison de la déconnexion
    occurredAt: string   // ISO 8601
}

type AlertConfig = NonNullable<AppConfig['alert']>

/**
 * Envoie un e-mail d'alerte de déconnexion.
 * Ne lève jamais d'erreur — les échecs sont silencieux pour le service.
 */
export async function sendDisconnectAlert(
    alertConfig: AlertConfig,
    details: AlertDetails
): Promise<void> {
    const transporter = nodemailer.createTransport({
        host:   alertConfig.smtpHost,
        port:   alertConfig.smtpPort,
        secure: alertConfig.smtpPort === 465,
        auth:   alertConfig.smtpUser
            ? { user: alertConfig.smtpUser, pass: alertConfig.smtpPass }
            : undefined,
    })

    const subject = `⚠️ WhatsApp Service — Déconnexion détectée`

    const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a;">
  <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:20px;margin-bottom:24px;">
    <h2 style="margin:0 0 8px;color:#dc2626;">⚠️ Déconnexion WhatsApp détectée</h2>
    <p style="margin:0;color:#b91c1c;">Le numéro administrateur a été déconnecté.</p>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="padding:10px;background:#f8fafc;font-weight:600;width:40%;">Numéro</td>
      <td style="padding:10px;">${details.phone}</td>
    </tr>
    <tr>
      <td style="padding:10px;background:#f8fafc;font-weight:600;">Raison</td>
      <td style="padding:10px;">${details.reason}</td>
    </tr>
    <tr>
      <td style="padding:10px;background:#f8fafc;font-weight:600;">Date / Heure</td>
      <td style="padding:10px;">${new Date(details.occurredAt).toLocaleString('fr-FR')}</td>
    </tr>
  </table>
  <div style="margin-top:24px;padding:16px;background:#f1f5f9;border-radius:8px;font-size:13px;color:#64748b;">
    <strong>Action requise :</strong> Connectez-vous au dashboard WhatsApp et scannez un nouveau QR code pour rétablir le service.
  </div>
</body>
</html>`

    try {
        await transporter.sendMail({
            from:    alertConfig.smtpFrom,
            to:      alertConfig.email,
            subject,
            html,
        })
        logger.info({ component: 'Mailer', to: alertConfig.email }, 'Alerte e-mail envoyée')
    } catch (err) {
        logger.error({ component: 'Mailer', err }, 'Échec envoi alerte e-mail')
    }
}
