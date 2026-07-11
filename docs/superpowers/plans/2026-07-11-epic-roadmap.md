# northstar — Claude Code Görev Listesi (Uygulama Planı)

**Tarih:** 2026-07-11 · **Repo:** northstar (Kilo Code + opencode fork'u) · **Sahip:** Ilura Technology OÜ

> Kaynak: kullanıcının 2026-07-11 tarihli EPIC görev listesi. Master plan (W0-W9) TAMAMLANDIKTAN sonra bu roadmap uygulanır.

Bu plan, kararlaştırılan işleri Claude Code'un uygulaması için epic'lere böler. **Her epic bir branch** (`feat/<epic-slug>`), her görev **kabul kriteriyle** biter.

## Uyulacak kurallar (AGENTS.md)

- Paylaşılan opencode dosyalarına dokunuşları `// kilocode_change` ile işaretle; yeni kodu mümkünse `packages/opencode/src/kilocode/` altına koy.
- Tek-kelime isim disiplini; `let`/`else`/boş `catch` kaçın; Bun API'leri.
- **Test:** `packages/opencode/`'tan `bun test` (root'tan ASLA). Typecheck: `bun turbo typecheck` (tsgo). Lint: `bun run lint` (oxlint).
- CI guard'ları: `bun run check-kilocode-change`, `bun run script/check-opencode-annotations.ts`, `bun run knip`, `bun run script/check-workflows.ts`.
- Kullanıcıya dönük her değişiklik için `.changeset/<slug>.md`.
- Her epic sonunda: exit testi + full-diff review → MERGE:READY olmadan sonraki epic'e geçme.

---

## EPIC 0 — Ön koşul kararları (bloklayıcı, çoğu non-code)

> Kod başlamadan netleşmeli; bazıları tek satır config, bazıları karar.

- [ ] **0.1 Lisans/open-core kararı.** MIT ↔ NOTICE "proprietary" çelişkisini çöz. Karar: moat (org runtime + apple-delivery) *private scope*ta mı kalacak yoksa açık mı? EPIC 3'ü bu belirler. Karardan sonra `LICENSE`/`NOTICE` güncelle.
- [ ] **0.2 İsim rezervasyonu.** npm'de `@ilura/northstar` (+ koruma: `northstar-cli`, `@northstar/cli`), PyPI/crates'te `northstar-cli`. Placeholder `0.0.0` publish ile isimleri kap.
- [ ] **0.3 `@mention` mid-run semantiği.** Varsayılan: **(a) yan-kanal not** — mesaj hedef ajanın oturumuna enjekte, runner sırayı yönetmeye devam. `pause/steer` ayrı komut. Kararı `docs/superpowers/` altına not düş.
- [ ] **0.4 (bilgi) Apple hesabı #1/#2.** W7 için gerekli; genelleştirme (EPIC 4) bunu beklemez, ama apple-delivery toolpack'i canlı test için gerekir.

---

## EPIC 1 — Rebrand: Kilo → northstar

**Branch:** `feat/rebrand-northstar` · **Bağımlılık:** 0.2

- [ ] **1.1 Paket kimliği.** `packages/opencode/package.json`: `name` → `@ilura/northstar`; `bin` → `{ "northstar": "./bin/..." }` (istersen `kilo` alias'ı geçişte tut). Root `package.json`: `repository.url`, `name`.
- [ ] **1.2 Config dir + env.** `~/.config/kilo` → `~/.config/northstar`; `kilo.jsonc` → `northstar.jsonc` (eski adı geriye-uyum için oku); `KILO_CONFIG`/`KILO_CONFIG_CONTENT`/`KILO_*` env → `NORTHSTAR_*` (eski adları fallback bırak). İlgili yer: `packages/opencode/src/config/`.
- [ ] **1.3 Installer.** `install` (kök): `APP=kilo`→`northstar`, `INSTALL_DIR=$HOME/.kilo/bin`→`$HOME/.northstar/bin`, binary adı (`mv .../kilo`), `command -v kilo`/`kilo --version`, logo + metin, 3 GitHub URL'i (EPIC 2'de repo'ya göre).
- [ ] **1.4 Self-update.** `packages/opencode/src/kilocode/installation/index.ts`: `Kilo-Org/kilocode` → `mrtcnbsk/northstar` (release kaynağı). Aksi halde `upgrade` Kilo binary'si çeker.
- [ ] **1.5 Kalan referanslar.** Grep `Kilo-Org/kilocode` ve kullanıcıya-dönük "Kilo Code" string'leri: `packages/opencode/src/kilocode/encoding.ts`, `src/cli/cmd/github.ts`, ilgili testler. Marka string'lerini northstar yap; **upstream atıf** (LICENSE/NOTICE/README) KALSIN.
- [ ] **1.6 Assetler.** `logo.png` ve TUI logosu.
- **Kabul:** `packages/opencode/`'tan `bun run build` → `northstar` binary; `northstar --version` çalışır; `check-forbidden-strings` + annotation guard'ları geçer; eski `~/.config/kilo` config'i hâlâ okunur (geriye-uyum).

---

## EPIC 2 — Terminal-only release hattı

**Branch:** `feat/release-terminal-only` · **Bağımlılık:** 1

- [ ] **2.1 publish.yml sadeleştir.** `if: github.repository == 'Kilo-Org/kilocode'` guard'ını `mrtcnbsk/northstar` yap. **Kaldır:** `build-vscode`, VSIX/Marketplace publish, JetBrains job'ları, AUR + Homebrew adımları. Kalan: version → build-cli → publish(npm + opsiyonel Docker).
- [ ] **2.2 npm çoklu-platform paketleme.** `script/publish.ts`: per-platform paket adı `@kilocode/cli-*` → `@ilura/northstar-*`; ana pakete `optionalDependencies` kablolamasını koru (`os`/`cpu` etiketleriyle). `script/build.ts`: arşiv/binary adları, repo slug.
- [ ] **2.3 curl|bash host.** `install`'ı raw GitHub URL'inden (ya da domain) servis et; README'ye tek-satır kurulum ekle: `curl -fsSL https://raw.githubusercontent.com/mrtcnbsk/northstar/main/install | bash`.
- [ ] **2.4 Secrets + version.** Repo secret: `NPM_TOKEN`. `script/version.ts` Kilo API'sine (`KILO_API_KEY`/`KILO_ORG_ID`) bağlıysa sadeleştir (git-tabanlı bump).
- [ ] **2.5 Workflow allowlist.** `script/check-workflows.ts` içindeki listeyi kaldırılan workflow'lara göre güncelle (CI guard geçsin).
- **Kabul:** Test release (draft) tüm platform binary'lerini üretir; `npm i -g @ilura/northstar` kurar ve `northstar` çalışır; `curl … | bash` kurar; kaldırılan job'lar CI'da yok.

---

## EPIC 3 — Open-core / moat ayrımı

**Branch:** `feat/open-core-split` · **Bağımlılık:** 0.1, 1

- [ ] **3.1 Sınır kararı uygula.** Moat = `src/kilocode/organization/` + `apple-delivery` toolpack (EPIC 4a) + Apple validator ajanları. Karara göre: (a) ayrı **private paket/scope**a taşı, ya da (b) feature-flag ile gate'le.
- [ ] **3.2 Public CLI moat'sız derlenebilsin.** Çekirdek CLI, moat paketi olmadan build + çalışsın (org özelliği yoksa graceful).
- [ ] **3.3 Lisans/atıf.** `LICENSE`/`NOTICE` netleştir; "Kilo" marka kullanımını üründen temizle (atıf hariç).
- **Kabul:** Public build moat'sız çalışır; moat paketi ayrı; `NOTICE` doğru; trademark taraması temiz.

---

## EPIC 4 — Genelleştirme: iOS fabrikası → genel org platformu

**Branch:** `feat/generalize-org` · **Bağımlılık:** 1 (3 ile paralel olabilir)

> Motor zaten generic; iş, iOS'e özel *içeriği* pluggable hale getirmek.

- [ ] **4.1 apple-delivery toolpack ayrımı.** Apple build/test/ASC tool'ları (`src/kilocode/asc/`, xcodebuild/simctl tool'ları) + Apple validator ajanları → adlandırılmış bir **toolpack**e topla. Org'lar `toolpacks: ["apple-delivery"]` ile opt-in etsin.
- [ ] **4.2 Toolpack registry + loader.** Ajan/org tanımında `toolpacks: [...]` alanı; loader ilgili tool'ları o ajanın tool erişimine ekler. iOS-dışı org onu yüklemez. (Mevcut tool/plugin + `.kilo/skills` sistemine oturt.)
- [ ] **4.3 organization.jsonc genelleştirme.** Runner/şemada iOS-hardcode olmadığını doğrula; `schema.ts` (döngü/eksik-ajan/derinlik doğrulaması) generic kalsın; pipeline aşama adları serbest.
- [ ] **4.4 Template sistemi.** `org-template/` → çoklu şablon: `ios-app-factory`, `blank`, `research-desk`, `content-studio`. Komut: `northstar org init --template <name>` → `.kilo/organization.jsonc` + `.kilo/agents/*.md` + `.kilo/command/*.md` iskeleti.
- [ ] **4.5 Giriş komutu genelleştirme.** `.kilo/command/build-app.md` iOS'e özel; generic `run`/org-tanımlı komut ekle (şablon kendi komutunu getirsin).
- **Kabul (exit testi):** `research-desk` şablonundan org kur → `--dry-run` geçer → oyuncak pipeline gerçek koşuda tamamlanır; `ios-app-factory` şablonu hâlâ çalışır; iOS-dışı org apple-delivery yüklemez.

---

## EPIC 5 — Provider/model authoring (BYOK + local)

**Branch:** `feat/provider-authoring` · **Bağımlılık:** 1

- [ ] **5.1 Komut parite.** `northstar models` / `providers` / `account` rebrand sonrası çalışsın (`src/cli/cmd/providers.ts`, `account.ts`).
- [ ] **5.2 TUI provider dialog.** `src/kilocode/cli/cmd/tui/component/dialog-provider.tsx`: BYOK key + local (Ollama/LM Studio/openai-compatible) ekleme; `baseURL`/preset; key global config'e yazılır (proje config `{env:}` çözmez — güvenlik notu korunur).
- [ ] **5.3 Local model doğrulama.** `limit.context`/`tool_call` set edilmemişse görünür uyarı (compaction kapanır). models.dev katalog fallback'i çalışsın.
- **Kabul:** TUI'dan provider ekle → `northstar models` listeler → bir ajana model dedikte edilebilir.

---

## EPIC 6 — TUI: Authoring (Builder)

**Branch:** `feat/tui-builder` · **Bağımlılık:** 4, 5 · **Referans:** builder mockup

> Kilocode-sahipli OpenTUI/SolidJS bileşenleri; `.kilo/` dosyalarını yazan/doğrulayan katman.

- [ ] **6.1 Models ekranı.** Bağlı sağlayıcılar + `northstar models` tablosu (ctx/tool/maliyet/sınıf); "+ sağlayıcı ekle" → dialog (EPIC 5.2).
- [ ] **6.2 Agents ekranı.** Sol: ajan kütüphanesi; sağ: editör — ad, mod, **model dedikte dropdown'ı** (bağlı modellerden), izin toggle'ları (edit/bash/web/task allow-ask-deny), subordinates seçici, toolpack kutucukları, rol/prompt textarea. Kaydınca `.kilo/agents/<ad>.md` yazılır.
- [ ] **6.3 Organization ekranı.** Şablon seçici; org grafiği (hiyerarşi); pipeline editörü (aşama ekle/sırala, kapı ekle/kaldır); canlı doğrulama paneli (döngü/eksik-ajan/derinlik — runner load-validation'ını UI'a bağla).
- **Kabul:** TUI'dan sıfır org (yeni ajan + pipeline) kur → `--dry-run` geçer → dosyalar doğru yazılır.

---

## EPIC 7 — TUI: Chat / Prompt + ajan seçimi

**Branch:** `feat/tui-chat` · **Bağımlılık:** 6 · **Referans:** chat mockup

- [ ] **7.1 Composer.** Kullanıcı prompt input'u; `/` slash komut paleti (`run`, `resume`, org komutları); `#` dosya mention.
- [ ] **7.2 Ajan seçici.** Chip dropdown'ı (org kadrosu + yerleşik ask/plan/code); `Tab` ile döndür; model-switch chip'i (görev-ortası model değiştirme). opencode agent-switch mantığını org roster'ıyla doldur.
- [ ] **7.3 `@mention` yönlendirme.** Mesajda `@ajan` → hedef ajana; **mid-run semantiği = 0.3 kararı** (varsayılan yan-kanal not enjeksiyonu; runner akışı korunur).
- [ ] **7.4 Inline kapı kartı.** Thread içinde kapı-onayı kartı (a/n/r → `org_decision` tool'una bağlan).
- **Kabul:** Chat'ten koşu başlat → mid-run `@analyst`'e not gönder → thread içi kapıda `approve` → runner ilerler.

---

## EPIC 8 — TUI: Cockpit / Koşu izleme

**Branch:** `feat/tui-cockpit` · **Bağımlılık:** 6 · **Referans:** cockpit mockup

- [ ] **8.1 Dashboard.** Canlı pipeline (aşama+durum) + ajan ağacı (CEO→şef→işçi, canlı) + bütçe göstergesi (eskalasyon eşiği) + akan log.
- [ ] **8.2 Kapı modalı + bildirim + bütçe.** Birinci-sınıf kapı modalı; kapı/bütçe/failure bildirimleri; her an görünür bütçe + sert `stop`.
- [ ] **8.3 Modlar.** Denetimli TUI · `--auto` headless · **attach** (salt-izleme). Ev ekranı = run listesi; `--dry-run` ön-uçuş ekranı.
- [ ] **8.4 İnce istemci.** Tümü `kilo serve` (→ `northstar serve`) SSE + `state.json` üzerine; attach/resume bedava gelsin. Chat/builder ile aynı event akışını paylaş (ileride web console'a).
- **Kabul:** Koşu canlı görünür; TUI kapanıp `attach` ile geri bağlanılır; kapı + bütçe-stop çalışır; `--auto` TUI'sız koşar.

---

## Önerilen sıra

```
0 (kararlar) → 1 (rebrand) → 2 (release)  ── dağıtım hattı ayakta
                    │
                    ├→ 3 (open-core)        ── 0.1'e bağlı, paralel
                    ├→ 4 (genelleştirme) → 5 (provider)
                    │           │
                    │           └→ 6 (builder) → 7 (chat)
                    │                        └→ 8 (cockpit)
```

İlk somut hedef: **1+2** (northstar adıyla kurulabilir CLI). Ürün farkı: **4** (genel org). Kullanım pratiği: **6/7/8** (TUI).

## Definition of Done (her epic)

- Paylaşılan dosya dokunuşları `// kilocode_change` işaretli; yeni kod `kilocode/` altında.
- `bun test` (paket bazlı) + yeni birim testler (org şema/runner, toolpack loader, chat routing) yeşil.
- `bun turbo typecheck`, `bun run lint`, `bun run knip`, annotation + kilocode-change + workflow guard'ları geçer.
- Kullanıcıya-dönük değişiklik için changeset.
- Exit testi koşulmuş + full-diff review MERGE:READY.
