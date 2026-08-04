/**
 * SubscriptionPlanStore.ts — Plans d'abonnement — MySQL.
 *
 * ── Plans actifs (à créer depuis le backoffice Admin > Plans) ─────────────
 *
 *  Gratuit
 *    Prix : 0 FCFA
 *    Type : requests (quota de messages)
 *    Valeur : 50 messages
 *
 *  Standard
 *    Prix : 1 500 FCFA
 *    Type : requests
 *    Valeur : 1 000 messages
 *
 *  Pro
 *    Prix : 7 000 FCFA
 *    Type : requests
 *    Valeur : 5 000 messages
 *
 *  Entreprise
 *    Prix : 12 500 FCFA
 *    Type : duration (durée)
 *    Valeur : 30 jours
 *
 * Pour mettre à jour les plans : Admin > Plans d'abonnements > Nouveau plan.
 * Pour modifier un plan existant : Admin > Base de données > subscription_plans.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { v4 as uuidv4 }   from 'uuid'
import { query, execute }  from './connection.js'
import { logger }          from '../services/logger.js'

export type UsageType = 'duration' | 'requests'

export interface SubscriptionPlan {
    id: string; name: string; price: number; unlimited: boolean
    usageType: UsageType | null; usageValue: number | null
    description: string | null; features: string[]; isPopular: boolean; createdAt: Date
}

interface SubscriptionPlanRow {
    id: string; name: string; price: number; unlimited: number
    usage_type: UsageType | null; usage_value: number | null
    description: string | null; features: string | null; is_popular: number; created_at: Date
}

function rowToPlan(row: SubscriptionPlanRow): SubscriptionPlan {
    let features: string[] = []
    if (row.features) {
        try { const f = typeof row.features === 'string' ? JSON.parse(row.features) : row.features; features = Array.isArray(f) ? f : [] }
        catch { features = [] }
    }
    return {
        id: row.id, name: row.name, price: row.price, unlimited: Boolean(row.unlimited),
        usageType: row.usage_type, usageValue: row.usage_value,
        description: row.description ?? null, features, isPopular: Boolean(row.is_popular), createdAt: row.created_at,
    }
}

export async function createSubscriptionPlan(data: {
    name: string; price: number; unlimited: boolean
    usageType?: UsageType | null; usageValue?: number | null
    description?: string | null; features?: string[]; isPopular?: boolean
}): Promise<SubscriptionPlan> {
    const id = uuidv4()
    await execute(
        `INSERT INTO subscription_plans (id, name, price, unlimited, usage_type, usage_value, description, features, is_popular) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, data.name, data.price, data.unlimited ? 1 : 0,
         data.unlimited ? null : (data.usageType ?? null),
         data.unlimited ? null : (data.usageValue ?? null),
         data.description ?? null,
         data.features ? JSON.stringify(data.features) : null,
         data.isPopular ? 1 : 0]
    )
    logger.info({ component: 'SubscriptionPlanStore', id, name: data.name }, 'Plan créé')
    const created = await getSubscriptionPlanById(id)
    if (!created) throw new Error('Plan introuvable après création')
    return created
}

export async function getSubscriptionPlanById(id: string): Promise<SubscriptionPlan | null> {
    const rows = await query<SubscriptionPlanRow>('SELECT * FROM subscription_plans WHERE id = ?', [id])
    return rows[0] ? rowToPlan(rows[0]) : null
}

export async function listSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    const rows = await query<SubscriptionPlanRow>('SELECT * FROM subscription_plans ORDER BY created_at DESC')
    return rows.map(rowToPlan)
}

export async function listPublicPlans(): Promise<SubscriptionPlan[]> {
    const rows = await query<SubscriptionPlanRow>('SELECT * FROM subscription_plans ORDER BY price ASC, created_at ASC')
    return rows.map(rowToPlan)
}

export async function getFreePlan(): Promise<SubscriptionPlan | null> {
    const rows = await query<SubscriptionPlanRow>('SELECT * FROM subscription_plans WHERE price = 0 ORDER BY created_at ASC LIMIT 1')
    return rows[0] ? rowToPlan(rows[0]) : null
}
