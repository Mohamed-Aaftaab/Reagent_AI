import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { PaymentRequirements, SupportedKind } from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";

/**
 * Erc7710ExactEvmScheme — extends the base server-side ExactEvmScheme to
 * advertise ERC-7710 delegation support in the PAYMENT-REQUIRED header.
 *
 * This tells x402 clients that this resource server can accept payments
 * that originate from a delegation chain, not just direct EOA payments.
 */
export class Erc7710ExactEvmScheme extends ExactEvmScheme {
  constructor(private readonly facilitatorClient: FacilitatorClient) {
    super();
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[]
  ): Promise<PaymentRequirements> {
    // Get the base enhanced requirements first
    const enhanced = await super.enhancePaymentRequirements(
      paymentRequirements,
      supportedKind,
      facilitatorExtensions
    );

    // Defensively fetch facilitator metadata — don't crash if unavailable
    let facilitators: string[] = [];
    try {
      const supported = await this.facilitatorClient.getSupported();
      const networkSigners = supported?.signers?.[paymentRequirements.network] ?? [];
      const wildcardSigners = supported?.signers?.["eip155:*"] ?? [];
      facilitators = [...networkSigners, ...wildcardSigners];
    } catch (err) {
      console.warn("Erc7710ExactEvmScheme: Could not fetch facilitator metadata, continuing without it.", err);
    }

    return {
      ...enhanced,
      extra: {
        ...enhanced.extra,
        assetTransferMethod: "erc7710",
        ...(facilitators.length > 0 ? { facilitators } : {}),
      },
    };
  }
}
