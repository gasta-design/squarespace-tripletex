import assert, { deepStrictEqual as assertEquals } from "node:assert/strict";
import { buildOrderLines, DEFAULT_SETTINGS, type Store, SyncEngine, type SyncedOrderRow, type TxApi } from "../supabase/functions/_shared/sync.ts";
import type { SqsOrder, SqsProduct } from "../supabase/functions/_shared/squarespace.ts";

const m = (v: number) => ({ currency: "NOK", value: v.toFixed(2) });

function order(over: Partial<SqsOrder> = {}): SqsOrder {
  return {
    id: "o1", orderNumber: "1001", createdOn: "2026-10-29T08:00:00Z", modifiedOn: "2026-10-29T08:05:00Z",
    customerEmail: "Kari@Example.no", fulfillmentStatus: "PENDING", paymentState: "PAID", testmode: false,
    billingAddress: { firstName: "Kari", lastName: "Nordmann", address1: "Gate 1", city: "Oslo", postalCode: "0150", countryCode: "NO" },
    shippingAddress: null,
    lineItems: [
      { id: "l1", sku: "SKU-1", productName: "Kopp", quantity: 2, unitPricePaid: m(250), variantOptions: [{ optionName: "Farge", value: "Blå" }] },
      { id: "l2", sku: null, variantId: "v9", productName: "Skål", quantity: 1, unitPricePaid: m(400) },
    ],
    subtotal: m(900), shippingTotal: m(99), discountTotal: m(100), taxTotal: m(179.8), refundedTotal: m(0), grandTotal: m(899),
    priceTaxInterpretation: "INCLUSIVE",
    ...over,
  };
}

class MemStore implements Store {
  client: Record<string, unknown> = {};
  orders = new Map<string, SyncedOrderRow>();
  products = new Map<string, number>();
  customers = new Map<string, number>();
  async updateClient(_id: string, p: Record<string, unknown>) { Object.assign(this.client, p); }
  async getSyncedOrder(_c: string, id: string) { return this.orders.get(id) ?? null; }
  async saveSyncedOrder(r: SyncedOrderRow) { this.orders.set(r.sqs_order_id, { ...r }); }
  async listRetryable(_c: string, max: number) { return [...this.orders.values()].filter((r) => r.status === "error" && r.attempts < max); }
  async getProductId(_c: string, n: string) { return this.products.get(n) ?? null; }
  async setProductId(_c: string, n: string, id: number) { this.products.set(n, id); }
  async getCustomerId(_c: string, e: string) { return this.customers.get(e) ?? null; }
  async setCustomerId(_c: string, e: string, id: number) { this.customers.set(e, id); }
}

class MockTx implements TxApi {
  calls: { fn: string; args: unknown }[] = [];
  nextId = 100;
  failInvoice = 0;
  existingProducts = new Map<string, number>();
  private log(fn: string, args: unknown) { this.calls.push({ fn, args }); }
  async countryId(c?: string | null) { return c === "NO" ? 161 : undefined; }
  async currencyId(_c: string) { return 5; }
  async vatTypeByNumber(n: string) { return { id: Number(n) * 10 }; }
  async findCustomerByEmail(_e: string) { return undefined; }
  async createCustomer(c: unknown) { this.log("createCustomer", c); return this.nextId++; }
  async findProductByNumber(n: string) { const id = this.existingProducts.get(n); return id ? { id, version: 1 } : undefined; }
  async createProduct(p: unknown) { this.log("createProduct", p); return this.nextId++; }
  async updateProduct(id: number, _v: number | undefined, p: unknown) { this.log("updateProduct", { id, p }); }
  async createOrder(o: unknown) { this.log("createOrder", o); return this.nextId++; }
  async invoiceOrder(id: number, p: unknown) {
    this.log("invoiceOrder", { id, p });
    if (this.failInvoice-- > 0) throw new Error("Faktura feilet: mangler bankkonto");
    return { id: this.nextId++, invoiceNumber: 5001 };
  }
}

const sqsWith = (orders: SqsOrder[], products: SqsProduct[] = []) => ({
  listOrders: async () => orders,
  getOrder: async (id: string) => orders.find((o) => o.id === id)!,
  listProducts: async () => products,
});

const client = (settings = {}) => ({
  id: "c1", name: "Test", active: true, settings: { ...settings, payment_type_id: 7 },
  sync_from: "2026-10-01T00:00:00Z", orders_watermark: null, products_watermark: null,
});
const now = () => new Date("2026-10-29T10:00:00Z");

Deno.test("buildOrderLines: inkl. mva, frakt og rabatt balanserer mot totalen", () => {
  const { lines, pricesIncludeVat, warning } = buildOrderLines(order(), DEFAULT_SETTINGS, { id: 30 }, null);
  assert(pricesIncludeVat);
  assertEquals(warning, undefined);
  assertEquals(lines.length, 4);
  assertEquals(lines[0].description, "Kopp (Blå)");
  assertEquals(lines[2], { description: "Frakt", count: 1, vatType: { id: 30 }, unitPriceIncludingVatCurrency: 99 });
  assertEquals(lines[3].unitPriceIncludingVatCurrency, -100);
  const sum = lines.reduce((a, l) => a + l.count * l.unitPriceIncludingVatCurrency!, 0);
  assertEquals(sum, 899);
});

Deno.test("buildOrderLines: rabatt som allerede er trukket fra legges ikke til igjen", () => {
  const o = order({ lineItems: [{ id: "l1", sku: "A", productName: "X", quantity: 1, unitPricePaid: m(400) }], shippingTotal: m(0), discountTotal: m(100), grandTotal: m(400) });
  const { lines, warning } = buildOrderLines(o, DEFAULT_SETTINGS, { id: 30 }, null);
  assertEquals(lines.length, 1);
  assertEquals(warning, undefined);
});

Deno.test("buildOrderLines: eks. mva bruker unitPriceExcludingVatCurrency", () => {
  const o = order({ priceTaxInterpretation: "EXCLUSIVE", discountTotal: m(0), grandTotal: m(999 * 1.25), taxTotal: m(999 * 0.25) });
  const { lines, pricesIncludeVat, warning } = buildOrderLines(o, DEFAULT_SETTINGS, { id: 30 }, null);
  assertEquals(pricesIncludeVat, false);
  assertEquals(warning, undefined);
  assert(lines.every((l) => l.unitPriceExcludingVatCurrency !== undefined && l.unitPriceIncludingVatCurrency === undefined));
});

Deno.test("full synk: kunde, produkter, ordre og betalt faktura", async () => {
  const store = new MemStore(), tx = new MockTx();
  const eng = new SyncEngine(client(), store, sqsWith([order()]), tx, { now });
  const r = await eng.run();
  assertEquals(r.ordersSynced, 1);
  assertEquals(r.ordersFailed, 0);
  const cust = tx.calls.find((c) => c.fn === "createCustomer")!.args as Record<string, unknown>;
  assertEquals(cust.name, "Kari Nordmann");
  assertEquals(cust.email, "kari@example.no");
  assertEquals((cust.postalAddress as Record<string, unknown>).country, { id: 161 });
  const prods = tx.calls.filter((c) => c.fn === "createProduct").map((c) => (c.args as { number: string }).number);
  assertEquals(prods, ["SKU-1", "SQS-v9"]);
  const ord = tx.calls.find((c) => c.fn === "createOrder")!.args as Record<string, unknown>;
  assertEquals(ord.orderDate, "2026-10-29");
  assertEquals(ord.currencyId, undefined);
  const inv = tx.calls.find((c) => c.fn === "invoiceOrder")!.args as { p: Record<string, unknown> };
  assertEquals(inv.p, { invoiceDate: "2026-10-29", sendToCustomer: false, paymentTypeId: 7, paidAmount: 899 });
  assertEquals(store.orders.get("o1")!.status, "done");
  assertEquals(store.orders.get("o1")!.tx_invoice_number, "5001");
  assertEquals(store.client.orders_watermark, "2026-10-29T09:59:30.000Z");
});

Deno.test("idempotens: ordre synkroniseres ikke to ganger, kunde gjenbrukes", async () => {
  const store = new MemStore(), tx = new MockTx();
  const o2 = order({ id: "o2", orderNumber: "1002", customerEmail: "kari@example.no" });
  await new SyncEngine(client(), store, sqsWith([order()]), tx, { now }).run();
  await new SyncEngine(client(), store, sqsWith([order(), o2]), tx, { now }).run();
  assertEquals(tx.calls.filter((c) => c.fn === "createOrder").length, 2);
  assertEquals(tx.calls.filter((c) => c.fn === "createCustomer").length, 1);
  assertEquals(tx.calls.filter((c) => c.fn === "createProduct").length, 2);
});

Deno.test("feil i faktura: ny-forsøk lager ikke ordren på nytt", async () => {
  const store = new MemStore(), tx = new MockTx();
  tx.failInvoice = 1;
  const r1 = await new SyncEngine(client(), store, sqsWith([order()]), tx, { now }).run();
  assertEquals(r1.ordersFailed, 1);
  assertEquals(store.orders.get("o1")!.status, "error");
  const sqs2 = { ...sqsWith([order()]), listOrders: async () => [] as SqsOrder[] }; // kun via ny-forsøk
  const r2 = await new SyncEngine(client(), store, sqs2, tx, { now }).run();
  assertEquals(r2.ordersSynced, 1);
  assertEquals(tx.calls.filter((c) => c.fn === "createOrder").length, 1);
  assertEquals(tx.calls.filter((c) => c.fn === "invoiceOrder").length, 2);
});

Deno.test("hopper over testordre, kansellerte og ubetalte", async () => {
  const store = new MemStore(), tx = new MockTx();
  const orders = [
    order({ id: "t", testmode: true }),
    order({ id: "c", fulfillmentStatus: "CANCELED" }),
    order({ id: "u", paymentState: "NOT_CHARGED" }),
  ];
  const r = await new SyncEngine(client(), store, sqsWith(orders), tx, { now }).run();
  assertEquals(r.ordersSynced, 0);
  assertEquals(r.ordersSkipped, 2);
  assertEquals(store.orders.has("u"), false); // ubetalt prøves igjen senere
  assertEquals(tx.calls.filter((c) => c.fn === "createOrder").length, 0);
});

Deno.test("utenlandsk valuta og 0-mva", async () => {
  const store = new MemStore(), tx = new MockTx();
  const o = order({ grandTotal: { currency: "EUR", value: "899.00" }, taxTotal: m(0) });
  await new SyncEngine(client({ sync_products: false }), store, sqsWith([o]), tx, { now }).run();
  const ord = tx.calls.find((c) => c.fn === "createOrder")!.args as { currencyId: number; lines: { vatType: { id: number } }[] };
  assertEquals(ord.currencyId, 5);
  assert(ord.lines.every((l) => l.vatType.id === 60)); // mva-kode 6
});

Deno.test("produktsynk oppretter og oppdaterer varianter", async () => {
  const store = new MemStore(), tx = new MockTx();
  tx.existingProducts.set("SKU-1", 555);
  const products: SqsProduct[] = [{
    id: "p1", type: "PHYSICAL", name: "Kopp",
    variants: [
      { id: "v1", sku: "SKU-1", pricing: { basePrice: m(300), salePrice: m(250), onSale: true }, attributes: { Farge: "Blå" } },
      { id: "v2", sku: "SKU-2", pricing: { basePrice: m(300) }, attributes: { Farge: "Rød" } },
    ],
  }];
  const r = await new SyncEngine(client({ sync_orders: false }), store, sqsWith([], products), tx, { now }).run();
  assertEquals(r.productsSynced, 2);
  const upd = tx.calls.find((c) => c.fn === "updateProduct")!.args as { id: number; p: { name: string; priceIncl: number } };
  assertEquals(upd.id, 555);
  assertEquals(upd.p.priceIncl, 250);
  assertEquals((tx.calls.find((c) => c.fn === "createProduct")!.args as { name: string }).name, "Kopp (Rød)");
  assert(store.client.products_watermark);
});

Deno.test("uten kundesynk brukes én felles nettbutikk-kunde", async () => {
  const store = new MemStore(), tx = new MockTx();
  const orders = [order(), order({ id: "o2", customerEmail: "per@example.no" })];
  await new SyncEngine(client({ sync_customers: false, sync_products: false }), store, sqsWith(orders), tx, { now }).run();
  assertEquals(tx.calls.filter((c) => c.fn === "createCustomer").length, 1);
});
