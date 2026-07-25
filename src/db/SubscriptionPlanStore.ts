/**
 * SubscriptionPlanStore.ts — CRUD des plans d'abonnement Convessa.
 */

import { v4 as uuidv4 } from 'uuid'
import { getPool }      from './connection.js'
import { logger }       from '../services/logger.js'
import type mysql from 'mysql2/promise'

export type UsageType = 'duration' | 'requests'

export interface SubscriptionPlan {
    id:         string
    name:       string
    price:      number
    unlimited:  boolean
    usageType:  UsageType | null
    usageValue: number | null
    createdAt:  Date
}

interface SubscriptionPlanRow {
    id:          string
    name:        string
    price:       number
    unlimited:   number
    usage_type:  UsageType | null
    usage_value: number | null
    created_at:  Date
}

function rowToPlan(row: SubscriptionPlanRow): SubscriptionPlan {
    return {
        id:         row.id,
        name:       row.name,
        price:      row.price,
        unlimited:  Boolean(row.unlimited),
        usageType:  row.usage_type,
        usageValue: row.usage_value,
        createdAt:  row.created_at,
    }
}

/**
 * Crée un nouveau plan d'abonnement.
 * L'id (uuid) est généré côté backend.
 */
export async function createSubscriptionPlan(data: {
    name:        string
    price:       number
    unlimited:   boolean
    usageType?:  UsageType | null
    usageValue?: number | null
}): Promise<SubscriptionPlan> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO subscription_plans (id, name, price, unlimited, usage_type, usage_value)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            id,
            data.name,
            data.price,
            data.unlimited ? 1 : 0,
            data.unlimited ? null : (data.usageType ?? null),
            data.unlimited ? null : (data.usageValue ?? null),
        ]
    )

    logger.info({ component: 'SubscriptionPlanStore', id, name: data.name }, 'Plan d\'abonnement créé')

    const created = await getSubscriptionPlanById(id)
    if (!created) throw new Error('Plan introuvable après création')
    return created
}

export async function getSubscriptionPlanById(id: string): Promise<SubscriptionPlan | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<SubscriptionPlanRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_plans WHERE id = ?',
        [id]
    )
    const row = rows[0]
    return row ? rowToPlan(row) : null
}

/**
 * Liste tous les plans d'abonnement (pour l'admin).
 */
export async function listSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    const pool   = getPool()
    const [rows] = await pool.execute<SubscriptionPlanRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_plans ORDER BY created_at DESC'
    )
    return (rows as SubscriptionPlanRow[]).map(rowToPlan)
}

/**
 * Liste les plans d'abonnement pour affichage public (page tarifs du site).
 * Triés par prix croissant — pas d'authentification requise pour cette route.
 */
export async function listPublicPlans(): Promise<SubscriptionPlan[]> {
    const pool   = getPool()
    const [rows] = await pool.execute<SubscriptionPlanRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_plans ORDER BY price ASC, created_at ASC'
    )
    return (rows as SubscriptionPlanRow[]).map(rowToPlan)
}

/**
 * Récupère le plan gratuit (price = 0) — utilisé pour attribuer les
 * privilèges par défaut à un tenant qui s'active SANS code de parrainage.
 * S'il existe plusieurs plans à 0, on prend le plus ancien.
 */
export async function getFreePlan(): Promise<SubscriptionPlan | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<SubscriptionPlanRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_plans WHERE price = 0 ORDER BY created_at ASC LIMIT 1'
    )
    const row = rows[0]
    return row ? rowToPlan(row) : null
}