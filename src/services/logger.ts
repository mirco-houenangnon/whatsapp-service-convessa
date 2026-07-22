/**
 * logger.ts — Instance pino configurée.
 * Format JSON en production, lisible (pino-pretty) en développement.
 * Les numéros de téléphone ne doivent jamais apparaître en clair dans les logs.
 */

import pino from 'pino'
import { config } from '../config.js'

const transport = !config.isProd
    ? {
        target: 'pino-pretty',
        options: {
            colorize:        true,
            translateTime:   'SYS:HH:MM:ss',
            ignore:          'pid,hostname',
            messageFormat:   '[{component}] {msg}',
        },
    }
    : undefined

export const logger = pino(
    {
        level: config.logLevel,
        base:  undefined, // supprime pid et hostname
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport ? pino.transport(transport) : undefined
)

/**
 * Masque un numéro de téléphone pour les logs.
 * Exemples :
 *   "+33612345678"  → "+336XXXXXX78"
 *   "22997123456"   → "229XXXXX56"
 */
export function maskPhone(phone: string): string {
    if (!phone) return '—'
    const clean = phone.replace(/\s/g, '')
    if (clean.length <= 4) return clean
    const start = clean.slice(0, clean.startsWith('+') ? 4 : 3)
    const end   = clean.slice(-2)
    const mid   = 'X'.repeat(Math.max(0, clean.length - start.length - end.length))
    return `${start}${mid}${end}`
}
