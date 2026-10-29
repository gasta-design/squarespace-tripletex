import { fetchRetry, HttpError, readJson } from "./http.ts";

export type TxEnv = "production" | "test";
export const TX_BASE: Record<TxEnv, string> = {
  production: "https://tripletex.no/v2",
  test: "https://api-test.tripletex.tech/v2",
};

export interface TxCredentials {
  environment: TxEnv;
  mode: "api_token" | "consumer_employee";
  apiToken?: string | null;
  consumerToken?: string | null;
  employeeToken?: string | null;
  companyId?: string;
}

type Ref = { id: number };
export interface TxAddress { addressLine1?: string; addressLine2?: string; postalCode?: string; city?: string; country?: Ref }
export interface TxOrderLine {
  product?: Ref; description: string; count: number; vatType: Ref;
  unitPriceIncludingVatCurrency?: number; unitPriceExcludingVatCurrency?: number;
}

function errMsg(body: unknown): string {
  const b = body as { message?: string; validationMessages?: { field?: string; message?: string }[] } | null;
  if (!b || typeof b !== "object") return String(body ?? "");
  const v = (b.validationMessages ?? []).map((m) => `${m.field ? m.field + ": " : ""}${m.message}`).join("; ");
  return [b.message, v].filter(Boolean).join(" – ");
}

/** Dato i norsk tid (YYYY-MM-DD). */
export function osloDate(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
}

export class Tripletex {
  private base: string;
  private auth: string | null = null;

  constructor(private creds: TxCredentials) {
    this.base = TX_BASE[creds.environment];
  }

  private async session(): Promise<string> {
    if (this.auth) return this.auth;
    let token: string | undefined;
    if (this.creds.mode === "api_token") {
      if (!this.creds.apiToken) throw new Error("Tripletex API-token mangler");
      const res = await fetchRetry(`${this.base}/token/session/:createFromRefreshToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken: this.creds.apiToken, ttlSeconds: 3600 }),
      }, "Tripletex");
      const body = await readJson(res) as { token?: string; value?: { token?: string } };
      if (!res.ok) throw new HttpError(res.status, `Tripletex innlogging feilet (${res.status}): ${errMsg(body)}`);
      token = body?.token ?? body?.value?.token;
    } else {
      if (!this.creds.consumerToken || !this.creds.employeeToken) throw new Error("Consumer-/employee-token mangler");
      const exp = osloDate(new Date(Date.now() + 2 * 86400000));
      const u = new URL(`${this.base}/token/session/:create`);
      u.searchParams.set("consumerToken", this.creds.consumerToken);
      u.searchParams.set("employeeToken", this.creds.employeeToken);
      u.searchParams.set("expirationDate", exp);
      const res = await fetchRetry(u.toString(), { method: "PUT", headers: { Accept: "application/json" } }, "Tripletex");
      const body = await readJson(res) as { value?: { token?: string } };
      if (!res.ok) throw new HttpError(res.status, `Tripletex innlogging feilet (${res.status}): ${errMsg(body)}`);
      token = body?.value?.token;
    }
    if (!token) throw new Error("Tripletex returnerte ingen session-token");
    this.auth = "Basic " + btoa(`${this.creds.companyId || "0"}:${token}`);
    return this.auth;
  }

  async request<T = unknown>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const res = await fetchRetry(u.toString(), {
      method,
      headers: {
        Authorization: await this.session(),
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, "Tripletex");
    const body = await readJson(res);
    if (!res.ok) throw new HttpError(res.status, `Tripletex ${method} ${path} (${res.status}): ${errMsg(body)}`, body);
    return body as T;
  }

  async list<T>(path: string, query: Record<string, string | number | boolean | undefined>): Promise<T[]> {
    const r = await this.request<{ values?: T[] }>("GET", path, { query });
    return r.values ?? [];
  }
  async create<T>(path: string, body: unknown): Promise<T> {
    const r = await this.request<{ value: T }>("POST", path, { body });
    return r.value;
  }

  // ---------- oppslag ----------
  async whoAmI(): Promise<{ companyName?: string; employee?: string }> {
    const r = await this.request<{ value?: { company?: { name?: string }; employee?: { firstName?: string; lastName?: string } } }>(
      "GET", "/token/session/>whoAmI", { query: { fields: "company(name),employee(firstName,lastName)" } });
    const e = r.value?.employee;
    return { companyName: r.value?.company?.name, employee: e ? `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim() : undefined };
  }

  private countryCache: Map<string, number> | null = null;
  async countryId(iso2?: string | null): Promise<number | undefined> {
    if (!iso2) return undefined;
    if (!this.countryCache) {
      const all = await this.list<{ id: number; isoAlpha2Code: string }>("/country", { fields: "id,isoAlpha2Code", count: 1000 });
      this.countryCache = new Map(all.map((c) => [c.isoAlpha2Code?.toUpperCase(), c.id]));
    }
    return this.countryCache.get(iso2.toUpperCase());
  }

  private currencyCache = new Map<string, number | undefined>();
  async currencyId(code: string): Promise<number | undefined> {
    if (!this.currencyCache.has(code)) {
      const r = await this.list<{ id: number; code: string }>("/currency", { code, fields: "id,code" });
      this.currencyCache.set(code, r.find((c) => c.code === code)?.id);
    }
    return this.currencyCache.get(code);
  }

  vatTypes() {
    return this.list<{ id: number; number: string; name: string; percentage: number }>(
      "/ledger/vatType", { fields: "id,number,name,percentage", count: 1000 });
  }

  private vatCache = new Map<string, Ref>();
  async vatTypeByNumber(number: string): Promise<Ref> {
    const hit = this.vatCache.get(number);
    if (hit) return hit;
    const all = await this.vatTypes();
    for (const v of all) this.vatCache.set(String(v.number), { id: v.id });
    const found = this.vatCache.get(number);
    if (!found) throw new Error(`Fant ikke mva-kode ${number} i Tripletex`);
    return found;
  }

  paymentTypes() {
    return this.list<{ id: number; description: string }>("/invoice/paymentType", { fields: "id,description", count: 100 });
  }

  // ---------- kunder ----------
  async findCustomerByEmail(email: string): Promise<number | undefined> {
    const r = await this.list<{ id: number; email?: string }>("/customer", { email, fields: "id,email", count: 5 });
    return r.find((c) => c.email?.toLowerCase() === email.toLowerCase())?.id ?? r[0]?.id;
  }
  async createCustomer(c: {
    name: string; email?: string; phoneNumber?: string; isPrivateIndividual: boolean;
    postalAddress?: TxAddress; physicalAddress?: TxAddress;
  }): Promise<number> {
    const v = await this.create<{ id: number }>("/customer", {
      ...c, isCustomer: true, invoiceEmail: c.email, invoiceSendMethod: "EMAIL",
    });
    return v.id;
  }

  // ---------- produkter ----------
  async findProductByNumber(number: string): Promise<{ id: number; version?: number } | undefined> {
    const r = await this.list<{ id: number; number?: string; version?: number }>(
      "/product", { productNumber: number, fields: "id,number,version", count: 10 });
    return r.find((p) => p.number === number);
  }
  async createProduct(p: { name: string; number: string; priceIncl?: number; priceExcl?: number; vatType: Ref }): Promise<number> {
    const v = await this.create<{ id: number }>("/product", {
      name: p.name.slice(0, 255),
      number: p.number,
      vatType: p.vatType,
      ...(p.priceExcl !== undefined ? { priceExcludingVatCurrency: p.priceExcl } : {}),
      ...(p.priceIncl !== undefined ? { priceIncludingVatCurrency: p.priceIncl } : {}),
    });
    return v.id;
  }
  async updateProduct(id: number, version: number | undefined, p: { name: string; priceIncl?: number; priceExcl?: number; vatType: Ref }) {
    await this.request("PUT", `/product/${id}`, {
      body: {
        id, ...(version !== undefined ? { version } : {}),
        name: p.name.slice(0, 255), vatType: p.vatType,
        ...(p.priceExcl !== undefined ? { priceExcludingVatCurrency: p.priceExcl } : {}),
        ...(p.priceIncl !== undefined ? { priceIncludingVatCurrency: p.priceIncl } : {}),
      },
    });
  }

  // ---------- ordre og faktura ----------
  async createOrder(o: {
    customerId: number; orderDate: string; currencyId?: number; reference: string;
    pricesIncludeVat: boolean; lines: TxOrderLine[]; comment?: string;
  }): Promise<number> {
    const v = await this.create<{ id: number }>("/order", {
      customer: { id: o.customerId },
      orderDate: o.orderDate,
      deliveryDate: o.orderDate,
      reference: o.reference,
      invoiceComment: o.comment,
      isPrioritizeAmountsIncludingVat: o.pricesIncludeVat,
      ...(o.currencyId ? { currency: { id: o.currencyId } } : {}),
      orderLines: o.lines,
    });
    return v.id;
  }

  async invoiceOrder(orderId: number, p: { invoiceDate: string; sendToCustomer: boolean; paymentTypeId?: number | null; paidAmount?: number }) {
    const r = await this.request<{ value: { id: number; invoiceNumber?: number } }>("PUT", `/order/${orderId}/:invoice`, {
      query: {
        invoiceDate: p.invoiceDate,
        sendToCustomer: p.sendToCustomer,
        ...(p.paymentTypeId && p.paidAmount !== undefined ? { paymentTypeId: p.paymentTypeId, paidAmount: p.paidAmount } : {}),
      },
    });
    return r.value;
  }
}
