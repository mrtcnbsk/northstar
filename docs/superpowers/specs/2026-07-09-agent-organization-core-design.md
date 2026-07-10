# Agent Organization — Çekirdek Tasarımı (Alt-proje 1)

**Tarih:** 2026-07-09
**Repo:** northstar (Kilo Code fork'u, opencode tabanlı monorepo)
**Durum:** Tasarım onaylandı (kullanıcı ile bölüm bölüm gözden geçirildi)

## 1. Amaç ve Vizyon

Northstar fork'u üzerinde, fikirden App Store yayın paketine uçtan uca ilerleyen,
hiyerarşik bir çok-agent organizasyonu kurmak:

- **CEO** (merkezi orkestratör) fikri alır, pipeline'ı yürütür, kullanıcıyla konuşur.
- **Departmanlar** (değerlendirme, planlama, UX, backend, frontend, test, debug,
  marketing) sırayla çalışır; her departmanda bir **şef** ve **işçi** agent'lar vardır.
- Her agent'ın kendi **rolü, LLM modeli, izinleri (yetki), yetenekleri ve
  do/don't listeleri** config dosyalarından tanımlanır.
- İnsan onayı iki kapıda: **Kapı-1** değerlendirme raporu sonrası (go/no-go),
  **Kapı-2** final paket sunumu (yayın onayı).

### Kullanıcı kararları (soru-cevap turlarından)

| Konu | Karar |
|---|---|
| Arayüz | Terminal (CLI/TUI) — opencode çekirdeği |
| LLM erişimi | BYOK (kendi API key'leri) + Kilo Gateway birlikte |
| Otonomi | İki insan kapısı; aradaki katmanlar otonom |
| Hedef platform | Native iOS (SwiftUI) |
| Org tanımı | Config dosyaları (versiyonlanabilir) |
| v1 kapsamı | Tam organizasyon (tüm departmanlar) |
| Yaklaşım | C — Tam ürünleştirme, 4 alt-projeye bölünmüş |

### Alt-proje dekompozisyonu (onaylı sıra)

1. **Organizasyon Çekirdeği** ← bu spec
2. Bütçe zorlama + yetenek-bazlı agent registry
3. Org paneli (kilo-console web görünümü)
4. Northstar rebrand

## 2. Mevcut Altyapı (keşif özeti)

Fork, opencode mimarisini taşır; ilgili yapı taşları:

- **Agent tanımları:** `packages/opencode/src/agent/agent.ts` (`Agent.Info`),
  Kilo eklentileri `packages/opencode/src/kilocode/agent/index.ts`. Özel agent'lar
  `.kilo/agents/*.md` (YAML frontmatter + system prompt gövdesi), yükleyici
  `packages/opencode/src/config/agent.ts`.
- **Delegasyon:** `task` tool'u (`packages/opencode/src/tool/task.ts`) child
  session açar; `background: true` paralel koşu; `task_id` ile resume.
  Parent-child bağı DB'de (`session.sql.ts: parent_id`).
- **İzinler:** `Permission.Ruleset` — tool başına, desen başına allow/ask/deny
  (`src/permission/index.ts`, `src/config/permission.ts`). Alt-agent izinleri =
  min(parent agent, parent session, child) (`src/agent/subagent-permissions.ts`).
- **Model seçimi:** agent başına `model: "provider/model-id"`, global
  `subagent_model` yedeği; çözümleme `Provider.parseModel/getModel`;
  trafik kilo-gateway üzerinden, BYOK destekli.
- **Config zinciri:** global `~/.config/opencode/kilo.jsonc` → proje `.kilo/` →
  env (`packages/opencode/src/config/config.ts`). Slash komutları
  `.kilo/command/*.md`. Plugin kancaları `src/plugin/index.ts`.
- **Maliyet:** child → parent maliyet toplaması
  (`kilocode/session/cost-propagation.ts`) — takip var, zorlama yok.

**Mimari engel:** alt-agent'ların alt-agent çağırması bilinçli kapalı —
`kilocode/tool/task.ts:40` (`nestedTask()` → `false`) ve
`subagent-permissions.ts` içinde `task: deny` hard-coded. CEO→Şef→İşçi
hiyerarşisi için seçici bir çekirdek yaması gerekir (bkz. §4).

**Fork disiplini:** `AGENTS.md` + CI guard'ları, Kilo'ya özgü kodun
`kilocode/` dizinlerinde ya da `// kilocode_change` işaretli olmasını zorlar.
Bu spec'teki tüm yeni kod bu kurala uyar.

## 3. Mimari Genel Bakış

```
┌─ Org Tanımı (config, versiyonlanır) ─────────────────────────────┐
│  .kilo/organization.jsonc     → departmanlar + pipeline + kapılar │
│  .kilo/agents/*.md            → 26 agent dosyası                  │
│  .kilo/command/build-app.md   → /build-app giriş komutu           │
├─ Org Runtime (yeni: packages/opencode/src/kilocode/organization/) ┤
│  schema.ts    → org config şeması + doğrulama (döngü/eksik agent) │
│  runner.ts    → aşama durum makinesi: sıra, kapılar, no-go        │
│  artifacts.ts → .kilo/org/<run-id>/ teslimat deposu + doğrulama   │
│  tools.ts     → org_status / org_advance / org_decision tool'ları │
├─ Çekirdek Yama (minimal, // kilocode_change işaretli) ────────────┤
│  Agent şemasına `subordinates: [...]` alanı; derinlik ≤ 2;        │
│  geçişli izin tavanı; org grafiği döngü kontrolü                  │
└───────────────────────────────────────────────────────────────────┘
```

**Kilit karar — deterministik runner:** Pipeline sıralaması, kapılar ve teslimat
doğrulaması CEO'nun LLM muhakemesine değil koda emanet edilir. CEO'nun modeli
yalnızca sentez ve kullanıcı iletişimi yapar; `org_advance` sırayı zorlar.
Gerekçe: token maliyeti, tekrarlanabilirlik, "aşama atlandı" hatasının yapısal
imkânsızlığı.

**Akış:** `/build-app <fikir>` → CEO koşu başlatır → `org_advance` sıradaki
departmanın şef oturumunu açar → şef işçilerini `task` ile çalıştırır →
teslimat `.kilo/org/<run-id>/deliverables/<stage>.md` → runner doğrular,
sonraki aşamaya önceki teslimat yollarını enjekte eder → kapılarda durup
kullanıcı kararı bekler.

## 4. Çekirdek Yaması: `subordinates` Alanı

Agent frontmatter'ına yeni alan: `subordinates: [agent-adı, ...]`

Semantik:
- `subordinates` bildiren agent, `task` ile **yalnızca** listedeki agent'ları
  çağırabilir (org şeması runtime'da zorlanan yetki grafiğine dönüşür).
- Bildirmeyen agent için mevcut davranış aynen korunur (delegasyon kapalı).
- Delegasyon derinliği ≤ 2 (CEO→şef→işçi); derinlik `KiloSession.resolveParent`
  zinciri yürünerek hesaplanır.
- İzin tavanı geçişli: işçi izinleri = min(CEO, şef, işçi). CEO ruleset'i bu
  yüzden "tüm departman ihtiyaçlarının tavanı" olarak tasarlanır (bkz. §7).
- Org grafiği yüklemede doğrulanır: döngü, kendine-referans, tanımsız agent
  adı → config hatası.

Dokunulan dosyalar (hepsi işaretli/kilocode-güvenli):
- `packages/opencode/src/config/agent.ts` — frontmatter şemasına alan ekleme
- `packages/opencode/src/agent/agent.ts` — `Agent.Info`'ya alan taşıma
- `packages/opencode/src/kilocode/tool/task.ts` — `nestedTask()`: subordinates
  bildirilmiş + derinlik < 2 ise izin
- `packages/opencode/src/agent/subagent-permissions.ts` — `task: deny`
  hard-code'unu subordinates'li agent'lar için allowlist'e çevirme
- `packages/opencode/src/tool/task.ts` — spawn edilebilir agent doğrulaması

## 5. Org Tanım Şeması

### 5.1 `organization.jsonc`

```jsonc
{
  "ceo": "ceo",
  "departments": {
    "evaluation": { "chief": "eval-chief", "workers": ["market-research", "competitor-analysis", "feasibility"] },
    "planning":   { "chief": "planning-chief", "workers": ["product-spec", "architect"] },
    "ux":         { "chief": "ux-chief", "workers": ["ux-designer"] },
    "backend":    { "chief": "backend-chief", "workers": ["data-layer-dev"] },
    "frontend":   { "chief": "frontend-chief", "workers": ["swiftui-dev-1", "swiftui-dev-2"] },
    "testing":    { "chief": "test-chief", "workers": ["unit-tester", "ui-tester"] },
    "debugging":  { "chief": "debug-chief", "workers": ["debugger"] },
    "marketing":  { "chief": "marketing-chief", "workers": ["aso-specialist", "copywriter", "pricing-analyst", "preview-designer"] }
  },
  "shared": ["apple-docs"],
  "pipeline": [
    { "stage": "evaluation", "gate": "human", "haltOn": "no-go" },
    { "stage": "planning" },
    { "stage": "ux" },
    { "stage": "backend" },
    { "stage": "frontend" },
    { "stage": "testing" },
    { "stage": "debugging" },
    { "stage": "marketing", "gate": "human" }
  ]
}
```

- `shared`: her şefin `subordinates` listesine runner'ın otomatik eklediği
  ortak danışman agent'lar (v1'de `apple-docs`).
- Pipeline sırası onaylı: UX frontend'den önce, backend frontend'den önce.

### 5.2 Agent dosyaları (`.kilo/agents/*.md`)

Mevcut Kilo agent-markdown formatı + yeni `subordinates` alanı. Örnek şef:

```markdown
---
description: Frontend departmanı şefi — SwiftUI ekibini yönetir
mode: subagent
model: anthropic/claude-fable-5
subordinates: [swiftui-dev-1, swiftui-dev-2]
permission:
  edit: { ".kilo/org/**": allow, "*": deny }
  bash: deny
---
# Rol
...
# Do
...
# Don't
...
```

Kadro: `ceo` (primary) + 8 şef + 16 işçi + `apple-docs` uzmanı = **26 agent
dosyası**; işçilerde `subordinates` yok. Agent prompt gövdeleri İngilizce yazılır
(model performansı), kullanıcıya dönük raporlar Türkçe üretilir (CEO ve şef
prompt'larında talimat olarak).

### 5.3 Giriş komutu

`.kilo/command/build-app.md` — `agent: ceo`; şablon, fikri org koşusu
başlatma talimatıyla CEO'ya iletir. `--resume <run-id>` ve `--dry-run`
varyantları desteklenir.

## 6. Orkestrasyon Akışı

Aşama yaşam döngüsü:

1. CEO `org_advance` çağırır → runner `state.json`'dan sıradaki aşamayı bulur;
   şef child-session'ını açar veya `task_id` ile devam ettirir.
2. Şef görev prompt'unu **runner üretir**: aşama hedefi + önceki teslimat
   yolları + proje kök dizini + teslimat şablonu.
3. Şef işi böler, işçileri `task` ile (gerekirse `background: true` paralel)
   çalıştırır, teslimatı yazar, `READY` ya da `BLOCKED: <neden>` döner.
4. Runner teslimatı doğrular (dosya var + boş değil), aşamayı `completed`
   işaretler, aşama maliyetini state'e yazar.
5. `gate: human` ise `AWAITING_APPROVAL` döner → CEO özeti kullanıcıya sunar,
   kararı `org_decision` ile işlenir: `approve` / `no-go` (temiz kapanış) /
   `revise: <not>` (aynı aşama, notla birlikte şefe geri).

Koşu durumu: `.kilo/org/<run-id>/state.json` — aşama durumları, kapı
kararları, maliyet dökümü, şef session-id'leri. `org_advance` idempotent;
koşu her an devam ettirilebilir.

## 7. İzin Matrisi ve Model Ataması

| Rol | edit | bash | web | task |
|---|---|---|---|---|
| CEO | yalnız `.kilo/org/**` | deny | deny | yalnız şefler (+`org_*`, `question: allow`) |
| Şefler | yalnız `.kilo/org/**` | deny | deny | yalnız kendi işçileri + apple-docs |
| Değerlendirme/marketing işçileri | yalnız kendi teslimatı | deny | websearch+webfetch allow | deny |
| Geliştirme işçileri | proje kaynak dizini | allowlist: `swift build`, `xcodebuild`, `git status/diff` | Apple docs domain'leri | deny |
| Test/debug işçileri | test + kaynak | allowlist: `xcodebuild test`, `xcrun simctl`, log okuma | deny | deny |
| apple-docs uzmanı | deny | deny | yalnız developer.apple.com / HIG | deny |

İzin min-kuralı üç seviyede geçişli çalıştığından CEO ruleset'i departman
ihtiyaçlarının **tavanı** olarak yazılır (webfetch/websearch/bash tavanda
allow); CEO'nun kendi kullanımı system-prompt + tool erişim listesiyle
kısıtlanır. Böylece "sessiz deny" riski kapanır.

> **(W1.0 amendment)** Yukarıdaki cümle CEO'nun kendi AGENT ruleset'inin (edit/bash
> deny gibi) departmanlara **doğrudan aktarılacağını** ima ediyordu — bu, W0-R1'in kök
> nedeniydi (bkz. `docs/superpowers/tracked-followups.md`, "Wave 1'de kapatıldı"): CEO'nun
> `edit: deny` kuralı her org edge'inde child session'a `"*" deny` olarak taşınıp
> şefin/worker'ın kendi allow kurallarını findLast ile eziyordu. Düzeltilmiş model: bir org
> edge'inin (parent → declared subordinate) **tavanı, parent'ın kendi ruleset'i DEĞİL,
> child'ın kendi bildirilmiş (declared) ruleset'idir** — `KiloTask.declaredSubordinate`
> parent'ın `subordinates` frontmatter bildirimi child'ı TAM adla içerdiği edge'lerde
> (W1.0b: tespit ruleset imzasından bildirilmiş alana taşındı — global bir deny-by-default
> task policy'si imzayı built-in'lerde üretebiliyordu; `subordinates` alanını enjekte
> edemez) parent'ın AGENT-seviyesi deny'larını child session'a aktarmayı durdurur. Parent SESSION deny'ları (üst zincirden gelen, ör. üç seviye yukarıdan
> bir gerçek kısıtlama) ve plan-family (`ask`/`plan`/`architect`) forwarding'i bu
> gevşetmenin DIŞINDADIR — hâlâ tam olarak aktarılır. "Sessiz deny" riski hâlâ kapalı: CEO
> departman ihtiyaçlarını KISITLAMIYOR (tavan artık departmanın kendi bildirdiği ruleset),
> yalnızca CEO'nun KENDİ kullanımı system-prompt + tool erişim listesiyle kısıtlı kalıyor.

Model stratejisi (dosyadan değiştirilebilir):
- CEO + şefler: frontier sınıf (ör. `anthropic/claude-fable-5`)
- Geliştirme/test işçileri: orta sınıf (ör. `anthropic/claude-sonnet-5`)
- Mekanik işler (keyword listeleri, metin varyantları): ekonomik sınıf (haiku)
- BYOK key'ler `kilo.jsonc` provider bloğunda; key'siz modeller Kilo
  Gateway'den akar; ikisi birlikte çalışır.

## 8. Hata Yönetimi

- **`BLOCKED`:** aşama `failed`; CEO nedeni ve seçenekleri (retry / revize
  notu / durdur) kullanıcıya sunar. Otomatik sessiz retry yok.
- **Teslimat doğrulaması geçmedi:** şefe tek otomatik hatırlatma; yine
  olmazsa `failed` + rapor.
- **Derinlik/yetki ihlali:** tool çağrısı açık hata döner (sessiz düşmez).
- **Maliyet:** aşama başına takip + kapı ekranlarında kümülatif gösterim
  (tavan zorlama Alt-proje 2).
- **Uzun oturumlar:** şef oturumlarında compaction eşiği config'te; departman
  arası aktarım context değil dosya üzerinden.
- **Kesilme:** `state.json` + idempotent `org_advance` ile her an resume.

## 9. Test Stratejisi

- **Birim (bun test):** org şeması doğrulama (döngü, eksik agent, çift şef);
  `subordinates` allowlist zorlaması; derinlik ≤ 2; 3-seviyeli izin tavanı;
  runner durum geçişleri (mock session: sıra, kapı, no-go, revise, resume);
  artifact doğrulama.
- **Entegrasyon:** 2 departmanlı oyuncak org fixture'ı, task tool stub'lı:
  (a) kapı-1 no-go → temiz kapanış, (b) approve → tamamlanış.
- **Kuru koşu:** `/build-app --dry-run` — LLM çağrısı olmadan pipeline'ı
  yürütür, agent/model/izin planını basar.
- **CI:** tüm yeni kod `kilocode/` altında; ortak dosya dokunuşları
  `// kilocode_change` işaretli; mevcut annotation guard'ları geçer.

## 10. Riskler ve Sınırlar

- İç içe delegasyonun güvenliği (derinlik, izin tavanı, maliyet toplama
  doğruluğu) artık bu fork'un sorumluluğu; testler bu yüzeyi kapsar.
- Upstream merge'lerde `src/tool/task.ts`, `subagent-permissions.ts`,
  `config/agent.ts` dokunuşları elle rebase ister (işaretli ve küçük).
- Kilo `orchestrator` agent'ı upstream'de deprecated — CEO **yeni** bir
  custom agent'tır, ona bağımlılık yok.
- Çok-agent koşuları token harcamasını çarpar; v1'de görünürlük var, sert
  tavan Alt-proje 2'de.
- Proje-içi agent markdown'ları güvensiz kabul edilir (mevcut kural):
  `{env:}` yok, `{file:}` proje köküne hapsedilir; sırlar yalnız global
  config'te.
