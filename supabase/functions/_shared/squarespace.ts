import { fetchRetry, HttpError, readJson } from "./http.ts";

const BASE = "https://api.squarespace.com";
const UA = "Gasta-Tripletex-Integration/1.0";

export interface Money { currency: string; value: string | number }
export interface SqsAddress {
  firstName?: string; lastName?: string; address1?: string; address2?: string | null;
  city?: string; state?: string; countryCode?: string; postalCode?: string; phone?: string;
}
export interface SqsLineItem {
  id: string; variantId?: string | null; productId?: string | null; sku?: string | null;
  productName?: string; quantity: number; unitPricePaid: Money;
  variantOptions?: { optionName: string; value: string }[] | null;
  lineItemType?: string;
}
export interface SqsOrder {
  id: string; orderNumber: string; createdOn: string; modifiedOn: string;
  customerEmail?: string; customerId?: string | null;
  billingAddress?: SqsAddress | null; shippingAddress?: SqsAddress | null;
  fulfillmentStatus: "PENDING" | "FULFILLED" | "CANCELED";
  paymentState?: string; testmode?: boolean; channel?: string;
  lineItems: SqsLineItem[];
  subtotal: Money; shippingTotal: Money; discountTotal: Money; taxTotal: Money;
  refundedTotal: Money; grandTotal: Money;
  priceTaxInterpretation?: "EXCLUSIVE" | "INCLUSIVE";
}
export interface SqsVariant {
  id: string; sku?: string;
  pricing?: { basePrice?: Money; salePrice?: Money; onSale?: boolean };
  attributes?: Record<string, string> | null;
}
export interface SqsProduct {
  id: string; type: string; name: string; isVisible?: boolean; modifiedOn?: string;
  variants?: SqsVariant[];
}
interface Page<T> { result?: T[]; products?: T[]; pagination?: { hasNextPage: boolean; nextPageCursor?: string } }

export class Squarespace {
  constructor(private apiKey: string) {}

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await fetchRetry(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}`, "User-Agent": UA, Accept: "application/json" },
    }, "Squarespace");
    const body = await readJson(res);
    if (!res.ok) {
      const msg = (body as { message?: string })?.message ?? JSON.stringify(body);
      throw new HttpError(res.status, `Squarespace ${res.status}: ${msg}`, body);
    }
    return body as T;
  }

  /** Alle ordre endret i [after, before]. */
  async listOrders(after: Date, before: Date): Promise<SqsOrder[]> {
    const out: SqsOrder[] = [];
    let page = await this.get<Page<SqsOrder>>("/1.0/commerce/orders", {
      modifiedAfter: after.toISOString(),
      modifiedBefore: before.toISOString(),
    });
    for (;;) {
      out.push(...(page.result ?? []));
      if (!page.pagination?.hasNextPage || !page.pagination.nextPageCursor) break;
      page = await this.get<Page<SqsOrder>>("/1.0/commerce/orders", { cursor: page.pagination.nextPageCursor });
    }
    return out;
  }

  getOrder(id: string): Promise<SqsOrder> {
    return this.get<SqsOrder>(`/1.0/commerce/orders/${encodeURIComponent(id)}`);
  }

  /** Produkter endret etter `after` (eller alle). Henter varianter separat om de mangler i listen. */
  async listProducts(after?: Date, before?: Date): Promise<SqsProduct[]> {
    const out: SqsProduct[] = [];
    const params: Record<string, string> = {};
    if (after && before) {
      params.modifiedAfter = after.toISOString();
      params.modifiedBefore = before.toISOString();
    }
    let page = await this.get<Page<SqsProduct>>("/v2/commerce/products", params);
    for (;;) {
      out.push(...(page.products ?? page.result ?? []));
      if (!page.pagination?.hasNextPage || !page.pagination.nextPageCursor) break;
      page = await this.get<Page<SqsProduct>>("/v2/commerce/products", { cursor: page.pagination.nextPageCursor });
    }
    const missing = out.filter((p) => !p.variants);
    for (let i = 0; i < missing.length; i += 50) {
      const ids = missing.slice(i, i + 50).map((p) => p.id).join(",");
      const full = await this.get<{ products: SqsProduct[] }>(`/v2/commerce/products/${ids}`);
      for (const fp of full.products ?? []) {
        const target = out.find((p) => p.id === fp.id);
        if (target) target.variants = fp.variants ?? [];
      }
    }
    return out;
  }

  /** Enkel tilkoblingstest: leser ordre fra siste døgn. */
  async test(): Promise<string> {
    const now = new Date();
    await this.get("/1.0/commerce/orders", {
      modifiedAfter: new Date(now.getTime() - 86400000).toISOString(),
      modifiedBefore: now.toISOString(),
    });
    return "OK";
  }
}

export const num = (m?: Money | null): number => (m ? Number(m.value) || 0 : 0);
