# Squarespace → Tripletex integracija

Slaptažodžiu apsaugota administravimo aplikacija (sąsaja norvegų kalba), kurioje kiekvienai Squarespace parduotuvei sukuriamas „klientas“ su jo Tripletex paskyra. Paspaudus **Aktiver** sistema kas 10 min automatiškai:

- **Produktai → produktai:** kiekvienas Squarespace variantas tampa Tripletex produktu (produkto nr. = SKU, jei SKU nėra, `SQS-<variantId>`).
- **Pirkėjai → klientai:** klientas randamas pagal el. paštą, jei nerandamas, sukuriamas su adresu.
- **Užsakymai → sąskaitos:** apmokėtas užsakymas tampa Tripletex užsakymu (prekės, pristatymas, nuolaida), iš jo sukuriama sąskaita ir, jei pasirinkta, iškart pažymima kaip apmokėta.

```
GitHub Pages (docs/index.html)  ──login──▶  Supabase Auth
        │                                         │
        └─▶ Edge Function "admin" ──▶ Postgres (klientai, užšifruoti raktai, žurnalas)
pg_cron (kas 10 min) ─▶ Edge Function "sync" ─▶ Squarespace API + Tripletex API
```

## Struktūra

| Kelias | Paskirtis |
|---|---|
| `supabase/migrations/…_init.sql` | Lentelės, RLS, užrakto funkcijos |
| `supabase/cron/` | Automatinio paleidimo kas 10 min nustatymas (pg_cron + Vault) |
| `.github/workflows/deploy.yml` | Automatinis diegimas į Supabase ir GitHub Pages |
| `supabase/functions/admin` | API administravimo sąsajai (tikrina prisijungimą) |
| `supabase/functions/sync` | Sinchronizacija vienam klientui (kviečia pg_cron) |
| `supabase/functions/_shared` | Squarespace / Tripletex klientai, sinchronizacijos logika, šifravimas |
| `tests/` | Testai (`deno test --allow-env tests/`) |
| `docs/` | Administravimo sąsaja GitHub Pages svetainei |

---

## Diegimas (automatinis per GitHub Actions)

Kiekvienas `git push` į `main` šaką automatiškai:
1. sukuria / atnaujina duomenų bazės lenteles (Supabase Management API);
2. pirmą kartą sugeneruoja `ENCRYPTION_KEY` ir `CRON_SECRET` (niekur nerodomi) ir nustato `ALLOWED_ORIGIN`;
3. įdiegia Edge Functions `admin` ir `sync`;
4. nustato pg_cron paleidimą kas 10 min;
5. uždaro viešą registraciją Supabase Auth ir nustato Site URL;
6. paskelbia administravimo sąsają GitHub Pages su teisingu `config.js`.

### Vienkartinis paruošimas
1. **Supabase:** sukurkite projektą ir **Authentication → Users → Add user** savo prisijungimą (pažymėkite *Auto Confirm User*).
2. **Supabase Access Token:** [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).
3. **GitHub repozitorija → Settings → Secrets and variables → Actions:**
   - *Secrets* → `SUPABASE_ACCESS_TOKEN` = Supabase tokenas
   - *Variables* → `SUPABASE_PROJECT_REF` = projekto ref (iš adreso `supabase.com/dashboard/project/<ref>`)
4. **Settings → Pages → Source: GitHub Actions.**
5. **Actions → Deploy → Run workflow.** Po ~2 min aplikacija veiks adresu `https://<vardas>.github.io/<repo>/`.

Kol `SUPABASE_PROJECT_REF` nenustatytas, diegimas tiesiog praleidžiamas.

> ⚠️ `ENCRYPTION_KEY` sugeneruojama tik vieną kartą. Neištrinkite jos iš Supabase → Edge Functions → Secrets, kitaip įvestų klientų raktų nebebus galima iššifruoti (tektų įvesti iš naujo).

---

## Vartotojai ir slaptažodžiai

Vieša registracija uždaryta. Visi vartotojai turi pilną prieigą ir valdomi pačioje aplikacijoje:

- **Brukere**: vartotojų sąrašas (sukūrimo ir paskutinio prisijungimo data), naujo vartotojo pridėjimas su laikinu slaptažodžiu ir ištrynimas. Savęs ištrinti negalima. Kitų vartotojų slaptažodžių keisti negalima, kiekvienas keičia tik savo (*Endre passord*).
- **Endre passord**: savo slaptažodžio keitimas. Būtina įvesti dabartinį slaptažodį, jis patikrinamas serveryje. Naujas slaptažodis turi būti bent 10 simbolių.

## Naujo kliento prijungimas

**Squarespace** (reikia Commerce Advanced plano): Settings → Advanced → **Developer API Keys** → Generate key. Pažymėkite **Orders** ir **Products** (pakanka Read Only). Raktas rodomas tik vieną kartą.

**Tripletex**, rekomenduojamas būdas yra **API-token (intern integrasjon)**, nes jam nereikia Tripletex patvirtinimo:
Selskap → **API-tokens** → sukurti tokeną (reikia administratoriaus teisių). Tokeną mato tik vieną kartą.
*(Alternatyva: consumer + employee token, bet consumer token išduodamas tik patvirtintiems Tripletex partneriams, patvirtinimas trunka 2–3 sav.)*

Tripletex paskyroje turi būti **įvestas įmonės banko sąskaitos numeris**, kitaip Tripletex neleis kurti sąskaitų.

Aplikacijoje:
1. **+ Ny klient** → pavadinimas, Squarespace raktas, Tripletex tokenas → **Lagre**.
2. **Test tilkobling**: abu turi būti ✓.
3. **Hent valg fra Tripletex** → pasirinkite **betalingstype** (sąskaita, į kurią registruojamas apmokėjimas, pvz. „Nettbutikk/Stripe“) ir PVM kodus (įprastai 3 = 25 %).
4. Neprivaloma: **Startpunkt**, nuo kada imti užsakymus (tuščia = nuo aktyvavimo).
5. **Aktiver**. Pirmas sinchronizavimas paleidžiamas iškart, vėliau kas 10 min. Rezultatai matomi skiltyje **Logg**.

## Kaip veikia (detalės)

- Imami tik **apmokėti** (`paymentState = PAID`) užsakymai. Atšaukti ir testiniai praleidžiami. Neapmokėti bus paimti, kai taps apmokėti.
- Kainos su PVM arba be jo nustatomos pagal Squarespace `priceTaxInterpretation`. Jei užsakymo PVM = 0 (pvz., eksportas), naudojamas „0 mva“ kodas.
- Pristatymas tampa atskira eilute „Frakt“, užsakymo nuolaida neigiama eilute „Rabatt“. Jei eilučių suma nesutampa su užsakymo suma, įspėjimas parodomas žurnale.
- Valiuta: jei ne NOK, užsakymui nustatoma atitinkama Tripletex valiuta.
- **Pakartotinio dubliavimo nėra:** kiekvienas užsakymas registruojamas, todėl antrą kartą nesukuriamas. Jei sukūrus užsakymą nepavyko sukurti sąskaitos, kitas bandymas sukuria tik sąskaitą. Klaidos kartojamos automatiškai iki 5 kartų, vėliau galima paspausti „Prøv igjen“.
- Vienu paleidimu apdorojama iki 40 užsakymų, likusieji perkeliami į kitą paleidimą.
- Visi API raktai saugomi užšifruoti (AES-256-GCM). Duomenų bazės lentelės nepasiekiamos per viešą raktą (RLS be politikų), prieiga tik per Edge Functions.

## Ribojimai, kuriuos verta žinoti

- **Grąžinimai (refunds)** nesinchronizuojami, kreditines sąskaitas reikia daryti rankiniu būdu.
- Tikslūs Squarespace ir Tripletex atsakymų formatai patikrinti pagal dokumentaciją, bet ne su tikromis paskyromis. **Pirmiausia išbandykite su Tripletex test aplinka** (Miljø → Test, nemokama test paskyra: developer.tripletex.no → Getting started).
- Jei visos parduotuvės prekės turi tą patį PVM tarifą, viskas veikia. Jei prekių tarifai skiriasi (pvz., maistas 15 %), reikės papildomo nustatymo pagal produktą.

## Problemų sprendimas

| Simptomas | Ką patikrinti |
|---|---|
| Nevyksta automatinis sinchronizavimas | SQL Editor: `select * from cron.job_run_details order by start_time desc limit 20;` |
| Nepavyko diegimas | GitHub → Actions → Deploy → žiūrėkite, kuris žingsnis raudonas |
| „Ikke innlogget“ | Ar vartotojas yra skiltyje *Brukere* (arba Supabase → Authentication → Users)? |
| Tripletex klaida apie banko sąskaitą | Tripletex: įveskite įmonės banko sąskaitą |
| Squarespace 401/403 | Raktas su Orders + Products teisėmis, Commerce Advanced planas |
| Edge Function žurnalai | Supabase → Edge Functions → sync/admin → Logs |
