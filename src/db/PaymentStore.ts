/**
 * PaymentStore.ts — Paiements d'abonnement — PostgreSQL.
 */

import { v4 as uuidv4 } from 'uuid'
import { query }        from './connection.js'
import { logger }       from '../services/logger.js'

export type PaymentGateway = 'fedapay' | 'kkiapay'
export type PaymentStatus  = 'pending' | 'success' | 'failed' | 'cancelled'

export interface SubscriptionPayment {
    id: string; tenantId: string; planId: string; gateway: PaymentGateway
    gatewayTxId: string | null; amount: number; currency: string
    status: PaymentStatus; createdAt: Date; updatedAt: Date
}

interface PaymentRow {
    id: string; tenant_id: string; plan_id: string; gateway: PaymentGateway
    gateway_tx_id: string | null; amount: number; currency: string
    status: PaymentStatus; created_at: Date; updated_at: Date
}

function rowToPayment(row: PaymentRow): SubscriptionPayment {
    return {
        id: row.id, tenantId: row.tenant_id, planId: row.plan_id, gateway: row.gateway,
        gatewayTxId: row.gateway_tx_id, amount: row.amount, currency: row.currency,
        status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    }
}

export async function createPayment(data: { tenantId: string; planId: string; gateway: PaymentGateway; amount: number; currency?: string }): Promise<SubscriptionPayment> {
    const id = uuidv4()
    await query(
        `INSERT INTO subscription_payments (id, tenant_id, plan_id, gateway, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [id, data.tenantId, data.planId, data.gateway, data.amount, data.currency ?? 'XOF']
    )
    logger.info({ component: 'PaymentStore', id, tenantId: data.tenantId }, 'Paiement créé')
    const payment = await getPaymentById(id)
    if (!payment) throw new Error('Paiement introuvable après création')
    return payment
}

export async function getPaymentById(id: string): Promise<SubscriptionPayment | null> {
    const rows = await query<PaymentRow>('SELECT * FROM subscription_payments WHERE id = $1', [id])
    return rows[0] ? rowToPayment(rows[0]) : null
}

export async function getPaymentByGatewayTxId(gatewayTxId: string): Promise<SubscriptionPayment | null> {
    const rows = await query<PaymentRow>('SELECT * FROM subscription_payments WHERE gateway_tx_id = $1 LIMIT 1', [gatewayTxId])
    return rows[0] ? rowToPayment(rows[0]) : null
}

export async function updatePaymentStatus(id: string, status: PaymentStatus, gatewayTxId?: string): Promise<void> {
    await query(
        `UPDATE subscription_payments SET status = $1, gateway_tx_id = COALESCE($2, gateway_tx_id), updated_at = NOW() WHERE id = $3`,
        [status, gatewayTxId ?? null, id]
    )
    logger.info({ component: 'PaymentStore', id, status }, 'Statut paiement mis à jour')
}

export async function listPaymentsByTenant(tenantId: string): Promise<SubscriptionPayment[]> {
    const rows = await query<PaymentRow>(
        'SELECT * FROM subscription_payments WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]
    )
    return rows.map(rowToPayment)
}
