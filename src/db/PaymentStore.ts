/**
 * PaymentStore.ts — CRUD des paiements d'abonnement.
 */

import { v4 as uuidv4 } from 'uuid'
import { getPool }      from './connection.js'
import { logger }       from '../services/logger.js'
import type mysql       from 'mysql2/promise'

export type PaymentGateway = 'fedapay' | 'kkiapay'
export type PaymentStatus  = 'pending' | 'success' | 'failed' | 'cancelled'

export interface SubscriptionPayment {
    id:           string
    tenantId:     string
    planId:       string
    gateway:      PaymentGateway
    gatewayTxId:  string | null
    amount:       number
    currency:     string
    status:       PaymentStatus
    createdAt:    Date
    updatedAt:    Date
}

interface PaymentRow {
    id:             string
    tenant_id:      string
    plan_id:        string
    gateway:        PaymentGateway
    gateway_tx_id:  string | null
    amount:         number
    currency:       string
    status:         PaymentStatus
    created_at:     Date
    updated_at:     Date
}

function rowToPayment(row: PaymentRow): SubscriptionPayment {
    return {
        id:          row.id,
        tenantId:    row.tenant_id,
        planId:      row.plan_id,
        gateway:     row.gateway,
        gatewayTxId: row.gateway_tx_id,
        amount:      row.amount,
        currency:    row.currency,
        status:      row.status,
        createdAt:   row.created_at,
        updatedAt:   row.updated_at,
    }
}

export async function createPayment(data: {
    tenantId:  string
    planId:    string
    gateway:   PaymentGateway
    amount:    number
    currency?: string
}): Promise<SubscriptionPayment> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO subscription_payments (id, tenant_id, plan_id, gateway, amount, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [id, data.tenantId, data.planId, data.gateway, data.amount, data.currency ?? 'XOF']
    )

    logger.info({ component: 'PaymentStore', id, tenantId: data.tenantId, planId: data.planId, gateway: data.gateway }, 'Paiement créé')

    const payment = await getPaymentById(id)
    if (!payment) throw new Error('Paiement introuvable après création')
    return payment
}

export async function getPaymentById(id: string): Promise<SubscriptionPayment | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<PaymentRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_payments WHERE id = ?', [id]
    )
    return rows[0] ? rowToPayment(rows[0]) : null
}

export async function getPaymentByGatewayTxId(gatewayTxId: string): Promise<SubscriptionPayment | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<PaymentRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_payments WHERE gateway_tx_id = ? LIMIT 1', [gatewayTxId]
    )
    return rows[0] ? rowToPayment(rows[0]) : null
}

export async function updatePaymentStatus(
    id:          string,
    status:      PaymentStatus,
    gatewayTxId?: string,
): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE subscription_payments
         SET status = ?, gateway_tx_id = COALESCE(?, gateway_tx_id), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, gatewayTxId ?? null, id]
    )
    logger.info({ component: 'PaymentStore', id, status }, 'Statut paiement mis à jour')
}

export async function listPaymentsByTenant(tenantId: string): Promise<SubscriptionPayment[]> {
    const pool   = getPool()
    const [rows] = await pool.execute<PaymentRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM subscription_payments WHERE tenant_id = ? ORDER BY created_at DESC',
        [tenantId]
    )
    return (rows as PaymentRow[]).map(rowToPayment)
}
