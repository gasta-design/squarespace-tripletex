import { num, type SqsAddress, type SqsLineItem, type SqsOrder, type SqsProduct } from "./squarespace.ts";
import { osloDate, type TxAddress, type TxOrderLine } from "./tripletex.ts";

// ---------- typer ----------
export interface Settings {
  sync_orders: boolean;
  sync_customers: boolean;
  sync_products: boolean;
  create_invoice: boolean;
  send_invoice_to_customer: boolean;
  mark_invoice_paid: boolean;
  payment_type_id: number | null;
  vat_type_number: string;
  zero_vat_type_number: string;
  include_test_orders: boolean;
  update_existing_products: boolean;
  product_prices_include_vat: boolean;
  shipping_line_text: string;
  discount_line_text: string;
}
export const DEFAULT_SETTINGS: Settings = {
  sync_orders: true,
  sync_customers: true,
  sync_products: true,
  create_invoice: true,
  send_invoice_to_customer: false,
  mark_invoice_paid: true,
  payment_type_id: null,
  vat_type_number: "3",
  zero_vat_type_number: "6",
  include_test_orders: false,
  update_existing_products: true,
  product_prices_include_vat: true,
  shipping_line_text: "Frakt",
  discount_line_text: "Rabatt",
};

export interface ClientRow {
  id: string; name: string; active: boolean;
  settings: Partial<Settings>;
  sync_from: string | null; orders_watermark: string | null; products_watermark: string | null;
}
export interface SyncedOrderRow {
  client_id: string; sqs_order_id: string; sqs_order_number?: string | null; sqs_modified_on?: string | null;
  status: "done" | "error" | "skipped";
  tx_customer_id?: number | null; tx_order_id?: number | null; tx_invoice_id?: number | null;
  tx_invoice_number?: string | null; attempts: number; error?: string | null;
}

/** Lagring (Supabase i produksjon, minne i tester). */
export interface Store {
  updateClient(id: string, patch: Record<string, unknown>): Promise<void>;
  getSyncedOrder(clientId: string, orderId: string): Promise<SyncedOrderRow | null>;
  saveSyncedOrder(row: SyncedOrderRow): Promise<void>;
  listRetryable(clientId: string, maxAttempts: number): Promise<SyncedOrderRow[]>;
  getProductId(clientId: string, number: string): Promise<number | null>;
  setProductId(clientId: string, number: string, id: number): Promise<void>;
  getCustomerId(clientId: string, email: string): Promise<number | null>;
  setCustomerId(clientId: string, email: string, id: number): Promise<void>;
}

export interface SqsApi {
  listOrders(after: Date, before: Date): Promise<SqsOrder[]>;
  getOrder(id: string): Promise<SqsOrder>;
  listProducts(after?: Date, before?: Date): Promise<SqsProduct[]>;
}
export interface TxApi {
  countryId(iso2?: string | null): Promise<number | undefined>;
  currencyId(code: string): Promise<number | undefined>;
  vatTypeByNumber(n: string): Promise<{ id: number }>;
  findCustomerByEmail(email: string): Promise<number | undefined>;
  createCustomer(c: { name: string; email?: string; phoneNumber?: string; isPrivateIndividual: boolean; postalAddress?: TxAddress; physicalAddress?: TxAddress }): Promise<number>;
  findProductByNumber(n: string): Promise<{ id: number; version?: number } | undefined>;
  createProduct(p: { name: string; number: string; priceIncl?: number; priceExcl?: number; vatType: { id: number } }): Promise<number>;
  updateProduct(id: number, version: number | undefined, p: { name: string; priceIncl?: number; priceExcl?: number; vatType: { id: number } }): Promise<void>;
  createOrder(o: { customerId: number; orderDate: string; currencyId?: number; reference: string; pricesIncludeVat: boolean; lines: TxOrderLine[]; comment?: string }): Promise<number>;
  invoiceOrder(orderId: number, p: { invoiceDate: string; sendToCustomer: boolean; paymentTypeId?: number | null; paidAmount?: number }): Promise<{ id: number; invoiceNumber?: number }>;
}

export interface RunResult {
  ordersSynced: number; ordersFailed: number; ordersSkipped: number; productsSynced: number;
  messages: string[];
}

export const MAX_ATTEMPTS = 5;
const DEFAULT_CUSTOMER_KEY = "__nettbutikk__";
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- hjelpere ----------
export function productNumberFor(item: { sku?: string | null; variantId?: string | null; productId?: string | null; id?: string }): string {
  const sku = item.sku?.trim();
  if (sku) return sku.slice(0, 100);
  return `SQS-${item.variantId || item.productId || item.id}`.slice(0, 100);
}

export function lineDescription(item: SqsLineItem): string {
  const opts = (item.variantOptions ?? []).map((o) => o.value).filter(Boolean).join(", ");
  return [item.productName ?? "Vare", opts && `(${opts})`].filter(Boolean).join(" ").slice(0, 255);
}

function txAddress(a: SqsAddress | null | undefined, countryId?: number): TxAddress | undefined {
  if (!a || (!a.address1 && !a.city && !a.postalCode)) return undefined;
  return {
    addressLine1: a.address1 ?? undefined,
    addressLine2: a.address2 ?? undefined,
    postalCode: a.postalCode ?? undefined,
    city: a.city ?? undefined,
    ...(countryId ? { country: { id: countryId } } : {}),
  };
}

/** Om ordren skal synkroniseres, og i så fall hvorfor ikke. */
export function skipReason(o: SqsOrder, s: Settings): string | null {
  if (o.testmode && !s.include_test_orders) return "Testordre";
  if (o.fulfillmentStatus === "CANCELED") return "Kansellert";
  if (o.paymentState && o.paymentState !== "PAID") {
    return o.paymentState === "REFUNDED" ? "Refundert før synk" : `Ikke betalt (${o.paymentState})`;
  }
  return null;
}

/** Bygger ordrelinjer for Tripletex fra en Squarespace-ordre. Ren funksjon. */
export function buildOrderLines(
  o: SqsOrder, s: Settings, vat: { id: number }, productIds: Map<string, number> | null,
): { lines: TxOrderLine[]; pricesIncludeVat: boolean; warning?: string } {
  const pricesIncludeVat = o.priceTaxInterpretation !== "EXCLUSIVE";
  const priceKey = pricesIncludeVat ? "unitPriceIncludingVatCurrency" : "unitPriceExcludingVatCurrency";
  const lines: TxOrderLine[] = [];

  for (const it of o.lineItems ?? []) {
    const pid = productIds?.get(productNumberFor(it));
    lines.push({
      ...(pid ? { product: { id: pid } } : {}),
      description: lineDescription(it),
      count: it.quantity,
      vatType: vat,
      [priceKey]: round2(num(it.unitPricePaid)),
    });
  }
  const shipping = num(o.shippingTotal);
  if (shipping > 0) {
    lines.push({ description: s.shipping_line_text || "Frakt", count: 1, vatType: vat, [priceKey]: round2(shipping) });
  }

  // Rabatt: legg til som negativ linje, men bare hvis den ikke allerede er trukket fra i varelinjene.
  const discount = num(o.discountTotal);
  const sum = () => round2(lines.reduce((a, l) => a + l.count * (l[priceKey] ?? 0), 0));
  const expected = round2(num(o.grandTotal) - (pricesIncludeVat ? 0 : num(o.taxTotal)));
  let warning: string | undefined;
  if (discount > 0 && Math.abs(sum() - expected) > 0.01) {
    lines.push({ description: s.discount_line_text || "Rabatt", count: 1, vatType: vat, [priceKey]: -round2(discount) });
  }
  const diff = round2(expected - sum());
  if (Math.abs(diff) > 0.01) {
    warning = `Linjesum avviker fra ordretotal med ${diff.toFixed(2)} ${o.grandTotal.currency}`;
  }
  return { lines, pricesIncludeVat, warning };
}

// ---------- synk-motor ----------
export class SyncEngine {
  s: Settings;
  result: RunResult = { ordersSynced: 0, ordersFailed: 0, ordersSkipped: 0, productsSynced: 0, messages: [] };

  constructor(
    private client: ClientRow, private store: Store, private sqs: SqsApi, private tx: TxApi,
    private opts: { maxOrders?: number; deadline?: number; now?: () => Date } = {},
  ) {
    this.s = { ...DEFAULT_SETTINGS, ...(client.settings ?? {}) };
  }

  private now() { return this.opts.now ? this.opts.now() : new Date(); }
  private timeLeft() { return (this.opts.deadline ?? Infinity) - Date.now(); }

  async run(): Promise<RunResult> {
    if (this.s.sync_products) {
      try {
        await this.syncProducts();
      } catch (e) {
        this.result.messages.push(`Produktsynk feilet: ${(e as Error).message}`);
      }
    }
    if (this.s.sync_orders) await this.syncOrders();
    return this.result;
  }

  // ----- produkter -----
  private async upsertProduct(number: string, name: string, price: number | undefined, pricesIncl: boolean, update: boolean): Promise<number> {
    const vat = await this.tx.vatTypeByNumber(this.s.vat_type_number);
    const priceFields = price === undefined ? {} : pricesIncl ? { priceIncl: round2(price) } : { priceExcl: round2(price) };
    let id = await this.store.getProductId(this.client.id, number);
    if (id && !update) return id;
    const existing = await this.tx.findProductByNumber(number);
    if (existing) {
      id = existing.id;
      if (update) await this.tx.updateProduct(id, existing.version, { name, vatType: vat, ...priceFields });
    } else {
      id = await this.tx.createProduct({ name, number, vatType: vat, ...priceFields });
    }
    await this.store.setProductId(this.client.id, number, id);
    return id;
  }

  async syncProducts() {
    const before = new Date(this.now().getTime() - 30_000);
    const after = this.client.products_watermark ? new Date(new Date(this.client.products_watermark).getTime() - 5 * 60_000) : undefined;
    const products = await this.sqs.listProducts(after, after ? before : undefined);
    let complete = true;
    for (const p of products) {
      if (p.type !== "PHYSICAL" && p.type !== "SERVICE" && p.type !== "DIGITAL") continue;
      for (const v of p.variants ?? []) {
        if (this.timeLeft() < 20_000) { complete = false; break; }
        const attrs = Object.values(v.attributes ?? {}).filter(Boolean).join(", ");
        const name = attrs ? `${p.name} (${attrs})` : p.name;
        const pr = v.pricing?.onSale && v.pricing.salePrice ? v.pricing.salePrice : v.pricing?.basePrice;
        const number = productNumberFor({ sku: v.sku, variantId: v.id, productId: p.id });
        try {
          await this.upsertProduct(number, name, pr ? num(pr) : undefined, this.s.product_prices_include_vat, this.s.update_existing_products);
          this.result.productsSynced++;
        } catch (e) {
          this.result.messages.push(`Produkt ${number}: ${(e as Error).message}`);
        }
      }
      if (!complete) break;
    }
    if (complete) {
      this.client.products_watermark = before.toISOString();
      await this.store.updateClient(this.client.id, { products_watermark: this.client.products_watermark });
    }
  }

  // ----- kunder -----
  private async customerFor(o: SqsOrder): Promise<number> {
    const email = o.customerEmail?.trim().toLowerCase();
    if (!this.s.sync_customers || !email) {
      const cached = await this.store.getCustomerId(this.client.id, DEFAULT_CUSTOMER_KEY);
      if (cached) return cached;
      const id = await this.tx.createCustomer({ name: "Nettbutikk (Squarespace)", isPrivateIndividual: true });
      await this.store.setCustomerId(this.client.id, DEFAULT_CUSTOMER_KEY, id);
      return id;
    }
    const cached = await this.store.getCustomerId(this.client.id, email);
    if (cached) return cached;
    let id = await this.tx.findCustomerByEmail(email);
    if (!id) {
      const b = o.billingAddress ?? o.shippingAddress ?? {};
      const name = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || email;
      const bc = await this.tx.countryId(o.billingAddress?.countryCode);
      const sc = await this.tx.countryId(o.shippingAddress?.countryCode);
      id = await this.tx.createCustomer({
        name, email, isPrivateIndividual: true,
        phoneNumber: b.phone || undefined,
        postalAddress: txAddress(o.billingAddress ?? o.shippingAddress, bc ?? sc),
        physicalAddress: txAddress(o.shippingAddress ?? o.billingAddress, sc ?? bc),
      });
    }
    await this.store.setCustomerId(this.client.id, email, id);
    return id;
  }

  // ----- ordre -----
  /** Synkroniserer én ordre. Idempotent: fortsetter der en tidligere kjøring stoppet. */
  async processOrder(o: SqsOrder): Promise<"done" | "skipped" | "error" | "unchanged"> {
    const prev = await this.store.getSyncedOrder(this.client.id, o.id);
    if (prev && (prev.status === "done" || prev.status === "skipped")) return "unchanged";

    const row: SyncedOrderRow = {
      client_id: this.client.id, sqs_order_id: o.id, sqs_order_number: o.orderNumber,
      sqs_modified_on: o.modifiedOn, status: "done",
      tx_customer_id: prev?.tx_customer_id ?? null, tx_order_id: prev?.tx_order_id ?? null,
      tx_invoice_id: prev?.tx_invoice_id ?? null, tx_invoice_number: prev?.tx_invoice_number ?? null,
      attempts: (prev?.attempts ?? 0) + 1, error: null,
    };

    const reason = skipReason(o, this.s);
    if (reason) {
      // Ikke-betalte ordre lagres ikke – de dukker opp igjen når de endres (f.eks. blir betalt).
      if (reason.startsWith("Ikke betalt")) return "unchanged";
      await this.store.saveSyncedOrder({ ...row, status: "skipped", error: reason, attempts: 0 });
      this.result.ordersSkipped++;
      return "skipped";
    }

    try {
      if (!row.tx_order_id) {
        row.tx_customer_id = await this.customerFor(o);
        const vat = await this.tx.vatTypeByNumber(num(o.taxTotal) === 0 ? this.s.zero_vat_type_number : this.s.vat_type_number);

        let productIds: Map<string, number> | null = null;
        if (this.s.sync_products) {
          productIds = new Map();
          for (const it of o.lineItems ?? []) {
            const n = productNumberFor(it);
            if (productIds.has(n)) continue;
            const pIncl = o.priceTaxInterpretation !== "EXCLUSIVE";
            productIds.set(n, await this.upsertProduct(n, lineDescription(it), num(it.unitPricePaid), pIncl, false));
          }
        }
        const { lines, pricesIncludeVat, warning } = buildOrderLines(o, this.s, vat, productIds);
        if (warning) this.result.messages.push(`Ordre #${o.orderNumber}: ${warning}`);

        const cur = o.grandTotal?.currency;
        const currencyId = cur && cur !== "NOK" ? await this.tx.currencyId(cur) : undefined;
        row.tx_order_id = await this.tx.createOrder({
          customerId: row.tx_customer_id!,
          orderDate: osloDate(new Date(o.createdOn)),
          currencyId,
          reference: `Squarespace #${o.orderNumber}`,
          comment: `Squarespace ordre #${o.orderNumber}`,
          pricesIncludeVat,
          lines,
        });
      }

      if (this.s.create_invoice && !row.tx_invoice_id) {
        const pay = this.s.mark_invoice_paid && this.s.payment_type_id;
        const inv = await this.tx.invoiceOrder(row.tx_order_id!, {
          invoiceDate: osloDate(new Date(o.createdOn)),
          sendToCustomer: this.s.send_invoice_to_customer,
          paymentTypeId: pay ? this.s.payment_type_id : null,
          paidAmount: pay ? round2(num(o.grandTotal)) : undefined,
        });
        row.tx_invoice_id = inv.id;
        row.tx_invoice_number = inv.invoiceNumber != null ? String(inv.invoiceNumber) : null;
      }

      await this.store.saveSyncedOrder(row);
      this.result.ordersSynced++;
      return "done";
    } catch (e) {
      row.status = "error";
      row.error = (e as Error).message.slice(0, 2000);
      await this.store.saveSyncedOrder(row);
      this.result.ordersFailed++;
      this.result.messages.push(`Ordre #${o.orderNumber}: ${row.error}`);
      return "error";
    }
  }

  async syncOrders() {
    const max = this.opts.maxOrders ?? 40;
    const syncFrom = this.client.sync_from ? new Date(this.client.sync_from) : this.now();
    const wm = this.client.orders_watermark ? new Date(this.client.orders_watermark) : syncFrom;
    const after = new Date(Math.max(syncFrom.getTime(), wm.getTime() - 5 * 60_000));
    const before = new Date(this.now().getTime() - 30_000);
    const handled = new Set<string>();
    let work = 0;

    if (after < before) {
      const orders = (await this.sqs.listOrders(after, before))
        .filter((o) => new Date(o.createdOn) >= syncFrom)
        .sort((a, b) => a.modifiedOn.localeCompare(b.modifiedOn));
      let newWatermark = before.toISOString();
      for (const o of orders) {
        if (work >= max || this.timeLeft() < 15_000) {
          newWatermark = new Date(new Date(o.modifiedOn).getTime() - 1).toISOString();
          this.result.messages.push("Tids-/antallsgrense nådd – fortsetter ved neste kjøring");
          break;
        }
        handled.add(o.id);
        const r = await this.processOrder(o);
        if (r !== "unchanged") work++;
      }
      this.client.orders_watermark = newWatermark;
      await this.store.updateClient(this.client.id, { orders_watermark: newWatermark });
    }

    // Prøv feilede ordre på nytt
    for (const r of await this.store.listRetryable(this.client.id, MAX_ATTEMPTS)) {
      if (handled.has(r.sqs_order_id) || work >= max || this.timeLeft() < 15_000) continue;
      try {
        const o = await this.sqs.getOrder(r.sqs_order_id);
        await this.processOrder(o);
        work++;
      } catch (e) {
        this.result.messages.push(`Ny-forsøk ${r.sqs_order_number ?? r.sqs_order_id}: ${(e as Error).message}`);
      }
    }
  }
}
