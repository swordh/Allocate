import { NextRequest, NextResponse } from 'next/server'

// CRITICAL: Must read raw body before any parsing.
// Stripe signature verification requires the unparsed request body.
// Do NOT use request.json() here — it consumes the stream before we can verify.
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const rawBody    = await request.text()
  const signature  = request.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!signature || !webhookSecret) {
    console.error('[webhooks/stripe]', { error: 'Missing stripe-signature or STRIPE_WEBHOOK_SECRET' })
    // Always return 200 to prevent Stripe from retrying configuration errors.
    return NextResponse.json({ received: true }, { status: 200 })
  }

  // Full Stripe webhook implementation delivered in Phase 4.
  // Signature verification and event handling will be added there.
  // For now: log that the webhook was received and return 200.
  console.log('[webhooks/stripe]', {
    action: 'webhook_received_stub',
    signaturePresent: Boolean(signature),
    bodyLength: rawBody.length,
  })

  return NextResponse.json({ received: true }, { status: 200 })
}
