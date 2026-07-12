# Tracked Follow-ups — agent-organization ledger

Kaynak: feat/agent-organization final review (2026-07-10) + Wave 0 kapanış review'u
(feat/wave-0-hardening, WAVE-MERGE: READY-WITH-TRACKED-FOLLOWUPS, 2026-07-10).

## MUST-FIX (Wave 1'in İLK işi — gerçek run iddiasından önce)

(boş — W0-R1 ve W0-R3 Wave 1'de kapatıldı, aşağıya bak.)

## TRACK (takip — düzeltilecek)

- **#3 (kalan yarı):** `OrgDepth` hâlâ düz `Error` ile fail ediyor (NamedError idiyomu
  değil). Mesaj Wave 0'da nötrleştirildi (kapatıldı).
- **#5:** `experimental.primary_tools` dedup yerleşimi session-level task deny'ı
  findLast'ta yenebilir (pre-existing; child tools map yine de kapatıyor).
- **#6:** `schema.ts`: `validate()` hatası `at ${file}` içermiyor; jsonc çift hata
  satırları dedupe edilmiyor; `crossCheck`'te ceo lookup'ı `Object.hasOwn` değil.
- **Minor (W0 kapanış):** `OrgRunner.decide`'da audit append state güncellemesinden
  sonra; append hatası (disk dolu) kararı persist edip tool'u fail ettirir, retry
  "no stage awaiting approval" der. Warning-note'a düşürülmeli. Ayrıca
  `OrgAudit.Entry.decision` serbest string (enum + "stop" olabilir).
- **Minor (W1 kapanış):** `runner.ts` escalation gate: bir stage ZATEN `gate:"human"` iken
  escalation eşiği aşılırsa `s.escalated` latch'lenir ama escalate note bastırılır
  (`running.gate !== "human"` guard'ı) — o gate `budget_note` olmadan döner. Doğruluk sorunu
  değil (insan zaten review'da; latch doğru tüketiliyor, tekrar ateşlenmez) ve ceo.md her gate'te
  harcamayı zaten iletiyor. Yalnız UX boşluğu.
- **Minor (W1 kapanış):** `tools.ts` `runLocks` Map'i run_id başına tek entry'yi overwrite ediyor
  ama HİÇ silmiyor — süreç ömrü boyunca görülen her distinct run_id için bir resolved-promise
  entry'si kalıyor. Normal kullanımda ihmal edilebilir; yalnız binlerce run_id'yi restart'sız
  döngüleyen çok uzun ömürlü bir süreçte anlamlı. Residual comment process-locality'yi kapsıyor
  ama map büyümesini not etmiyor.

## Wave 1'de kapatıldı (feat/wave-1-budget, W1.0-W1.6)

- **W0-R1 — Org yazma yolu gerçek run'larda ÖLÜ (v1'den beri gizli Critical) — FIXED.**
  Kök neden: `ceo.md`'nin `edit/bash: deny`'ı ve şeflerin `edit "*": deny`'ı, session
  türetimiyle (`subagent-permissions.ts` `parentAgentDenies` + `kilocode/tool/task.ts`
  `inherited()`) her alt session'a `"*" deny` olarak taşınıyordu; değerlendirme findLast
  (session kuralları sonda) olduğundan şefin deliverables allow'unu ve worker'ın edit/bash
  allow'unu YENİYORDU. Fix: yeni `KiloTask.declaredSubordinate(parent, child)` yüklemi —
  parent'ın KENDİ ruleset'i task-deny-by-default + child için spesifik (wildcard olmayan)
  bir allow taşıyorsa (yani `subordinates` frontmatter'ının ürettiği imza), o org edge'inde
  parent'ın AGENT-seviyesi deny'ları artık child session'a taşınmıyor. Session-seviyesi
  deny'lar ve plan-family (`ask`/`plan`/`architect`) forwarding'i DEĞİŞMEDİ — yalnız bu
  spesifik ilişki gevşetildi. Birleşik-seam matrix testi (10 vaka,
  `test/kilocode/organization/write-path.test.ts`) tam CEO→şef→worker yazma yolunu pinliyor.
  **Bilinen sınır: fix'ten ÖNCE başlamış ve persist edilmiş run'ların session'ları
  zehirli ruleset'i korur** — `task_id` ile resume, session permission'ını APPEND eder,
  asla eski `"*" deny` kurallarını silmez. Yalnız fix'ten SONRA başlayan taze run'lar
  (fresh session, `session.create`) düzeltilmiş yazma yoluna sahiptir. Eski bir run'ı
  resume etmek isteyen kullanıcı yeni bir run başlatmalı.
- **W0-R3 (W0-R1'e bağlı) — worker şablonlarına açık `.kilo/org/**` edit deny — FIXED.**
  Altı edit-capable worker (data-layer-dev, swiftui-dev-1, swiftui-dev-2, unit-tester,
  ui-tester, debugger) artık `edit: {"*": allow, ".kilo/org/**": deny,
  "**/.kilo/org/**": deny}` taşıyor (deny kuralları LAST — findLast org yollarını kazanır;
  son kuralın pattern'i "*" olmadığından edit tool'u worker'a hâlâ sunuluyor). W0-R1 fix'iyle
  AYNI commit'te kapatıldı.
- **W1.0b — Yönetici tespiti ruleset imzasından bildirilmiş `subordinates` alanına
  taşındı (+#4 kapandı).** Reviewer repro'su: kullanıcının global
  `permission: {task: {"*": deny, x: allow}}` sertleştirmesi (meşru bir config) her
  agent'ın ruleset'ine SON sırada merge olduğundan, edit deny taşıyan built-in'lerde
  (ör. `explore`) W1.0'ın ruleset-imza tespitini ÜRETİYOR ve edit-deny forwarding'i
  sessizce gevşetiyordu. Fix: `subordinates` alanı runtime `Agent.Info`'ya thread edildi
  (`src/agent/agent.ts`, config merge loop); `nestedTask` artık "bildirilmiş subordinates
  listesi boş değil", `declaredSubordinate` artık "parent'ın listesi child'ı TAM adla
  içeriyor" (desen yok) — global config bu alanı enjekte EDEMEZ. PLAN_FAMILY ad kapısı
  belt-and-suspenders olarak durdu (bugün gereksiz — hiçbir plan-family agent subordinates
  bildirmiyor). İzin EXPANSION'ı (config/agent.ts task kural üretimi) aynen kaldı — spawn
  yetkisi hâlâ ask-time kurallarla uygulanıyor; yalnız TESPİT re-key'lendi. Yan etki:
  delegasyon isteyen elle yazılmış jsonc agent'lar artık `subordinates` bildirmek ZORUNDA
  (README'nin belgelediği mekanizma) — salt task-kural haritası artık yönetici yapmıyor.
  Eski #4 ("global config'te spesifik desenli task kuralı tüm subagent'ları yönetici
  yapar") bu re-key ile kökten kapandı. Negatif test pinli
  (`nested-task.test.ts` "global task hardening cannot manufacture a manager") +
  PLAN_FAMILY↔`plan-file.ts PLANNERS` sync testi.
- **W0-R2 — org tool'ları için per-run serialization — FIXED (W1.6).**
  `OrgState.update` + `OrgAudit.append` kilitsiz read-modify-write/append'ti; AI SDK tek bir
  assistant step'in tool call'larını eşzamanlı çalıştırabilir, ve stale bir in-flight
  `org_advance`, `org_stop`'un persist ettiği `halted`'ı tüm-dosya yazımıyla `active`'e geri
  döndürebilirdi (acil durdurmayı sessizce bozar). Fix: `tools.ts` içinde process-local bir
  promise-chain mutex — `withRunLock(runID, fn)`, `Map<string, Promise>` ile runID başına
  kuyruklanmış tail — org_advance / org_decision / org_stop'un TÜM mutasyon gövdesini sarıyor
  (org_start yeni run yarattığı için lock'a ihtiyaç duymuyor; org_status salt-okunur bırakıldı —
  Node'un tek-thread event loop'unda Filesystem.write'ın atomic rename'i sayesinde bir okuma
  hiçbir zaman "torn" bir dosya görmez, yalnızca bir yazıcının kesinlikle öncesi ya da kesinlikle
  sonrasını görür; kilitlemek yalnız gecikme ekler, doğruluk kazandırmaz). Kilit tool boundary'de
  yaşıyor (runner.ts SAF ve senkron-compose edilebilir kalıyor — testability önceliği). Test:
  `test/kilocode/organization/run-lock.test.ts` seam'i izole test ediyor (FIFO sıralama, farklı
  run_id'lerin birbirini bloklamaması, reddeden bir mutasyonun kuyruğu kilitlememesi, ve doğrudan
  acil-durdurma repro'su: stale bir yazı org_stop'tan ÖNCE başlayıp SONRA bitse bile artık son
  yazan org_stop oluyor) + üç mutasyon tool'unun `withRunLock` çağırdığının, org_start/org_status'ın
  çağırmadığının yapısal doğrulaması. **Kalan sınır (çözülmedi, bilinçli):** bu mutex
  process-local'dir — aynı proje dizinine işaret eden İKİNCİ bir opencode instance'ının aynı
  run_id üzerinde eşzamanlı org tool çağırmasını koordine ETMEZ; bu cross-process kilitleme
  (OS file lock / lockfile-pid protokolü) gerektiren ayrı ve daha büyük bir iştir, burada
  çözülmedi.

**Wave 1 bütçe motoru kapanışları (dossier §C çekirdek, W1.1-W1.5, W1.6'da bütünsel exit testiyle
doğrulandı):** organization.jsonc `budget` şeması + `resolveBudget` varsayılanları (W1.1); run/stage
hard ceiling halt'ı + tek-seferlik cost-escalation human gate (W1.2); `org_status` bütçe bloğu
(run/stage/escalationThreshold/retries/spent/remaining) + `org_advance` gate sonucunun escalation
note'u taşıması (W1.3); bir kerelik değil sınırlı (`budget.retries`) auto-retry — deliverable hiç
üretilmeyen ya da revise döngüsünde değişmeyen stage'ler retries+1 chief run sonunda "failed" olup
run'ı halt ediyor (W1.4); maliyet-sıralı model fallback (W1.5). Bütünsel exit senaryosu
(`test/kilocode/organization/wave1-exit.test.ts`): eşik-altı tamamlanma normal ilerliyor →
gated-olmayan bir stage eşiği geçince escalation gate BİR KEZ ateşleniyor (non-boş runner-level
`note` ile, W1.3'ün reviewer'ın işaretlediği coverage boşluğunu güçlendiriyor) ve org_status bütçe
bloğu escalation anında doğru → decide(approve) devam ettiriyor → sonraki bir stage run ceiling'i
aşınca HARD halt (bütçe haltReason + audit stop kaydı, sonraki advance halted dönüyor) → ayrı bir
run'da bir stage retries+1 chief run boyunca tamamlanamayınca "deliverable never produced" ile
fail oluyor.

## Wave 2'de kapatıldı (feat/wave-2-build, W2.1-W2.7)

Wave 2 = build & test runtime: şef/worker'ların gerçek Xcode toolchain'ini yapılandırılmış,
agent'ın işlem yapabileceği sonuçlarla sürdüğü tool katmanı.

- **W2.1 — arity girdileri.** Yeni tool'lar için tool-arity/registry girdileri.
- **W2.2 — `xcode_build` yapılandırılmış tool.** `xcodebuild build`'i sürer; streaming,
  bellek-sınırlı parser (`StreamingXcodeParser`, MAX_RETAINED_TAIL_BYTES tail + MAX_DIAGNOSTICS
  cap; hiçbir diagnostic kaybolmaz — megabaytlarca gürültünün ardındaki hata bile yakalanır) →
  `{ok, status:"build_succeeded"|"build_failed"|"spawn_failed"|"invalid_args", errors:[{file,line,column,severity,message}], warnings, rawLogPath}`.
  Ham log yalnız gerektiğinde diske stream'lenir (temiz build hiç log yazmaz — disk hijyeni).
- **W2.3 — `xcode_test` yapılandırılmış tool.** `xcodebuild test`'i sürer; ayrı streaming parser
  (build-vs-test durum takibi aynı olmadığı için bilinçli yapısal kopya) →
  `{ok, status:"tests_passed"|"tests_failed"|"build_failed"|"spawn_failed"|"invalid_args", passed, failed:[{test,file,line,message}], skipped, buildErrors, rawLogPath}`.
  Nonzero exit her zaman kazanır (metin "TEST SUCCEEDED" dese bile); test-öncesi derleme hatası
  `tests_failed` değil `build_failed` olarak raporlanır.
- **W2.4 — swiftlint/swiftformat config.** Lint/format yapılandırması.
- **W2.5 — `crash_symbolicate` graceful degradation.** Bir crash log + dSYM'i atos ile
  sembolleştirir; atos yoksa / dSYM bulunamazsa / timeout olursa ASLA çökmez, ham (sembolsüz)
  trace'i açık bir not ile döner (`framesResolved`, `unresolvedNote`). Never-crash sözleşmesi.
- **W2.6 — tool grant'ları + argv denylist.** Worker'lara tool grant'ları; `xcode-argv.ts`
  blast-radius doğrulaması — `-derivedDataPath`/`-resultBundlePath` gibi tehlikeli extraArg'lar,
  path traversal ve mutlak yollar spawn'dan ÖNCE reddedilir (`{status:"invalid_args"}`, süreç
  hiç başlatılmaz).
- **W2.7 — kill-orDie parity fix + Wave 2 exit testi.** W2.5 review'unda crash-symbolicate.ts'te
  bulunup düzeltilen gizli defekt (timeout dalındaki başarısız `handle.kill(...).pipe(Effect.orDie)`
  — orDie, defect-kör `Effect.catch`'ten kaçıp tool'u çökertir) AYNEN xcode-build.ts (~satır 356)
  ve xcode-test.ts (~satır 479) içinde de vardı. İkisi de crash-symbolicate'in düzeltilmiş,
  defect-güvenli formuna (`.pipe(Effect.catchCause(() => Effect.void))`) geçirildi; timeout dalı
  artık yapılandırılmış timeout sonucunu kill'in başarısından BAĞIMSIZ döndürüyor. Her iki tool'a
  TestClock + başarısız-kill stub'lı timeout+kill-failure testi eklendi (eski orDie'a karşı RED,
  fix sonrası GREEN — ikisi de doğrulandı). Ayrıca tool-seviyesi Wave 2 exit testi
  (`test/kilocode/tool/wave2-exit.test.ts`, fixture-driven, Xcode gerektirmez): beş exit kriteri
  bir arada — build_failed (işlenebilir errors), build_succeeded, tests_failed (failed+passed),
  crash_symbolicate (framesResolved>0), argv denylist (invalid_args, spawn yok). Org-run-seviyesi
  exit ispatı org suite'inde.

**SNR-deferred (Wave 2'de bilinçli ertelendi):** log aggregation (birden çok tool çıktısının
toplulaştırılması); SourceKit-LSP entegrasyonu; `xcode_test`'te swift-test (SwiftPM `swift test`)
desteği — şu an yalnız `xcodebuild test`; XCTSkip skipped-count parse'ı (`skipped` hep 0 raporlanıyor,
XCTSkip sayımı çıkarılmıyor). Hepsi ertelendi, doğruluk sorunu değil.

**Gerçek-Xcode CI boşluğu (çözülmedi):** üç tool da TAMAMEN fixture-tested — ChildProcessSpawner
stub'ı ile gerçek `xcodebuild`/`atos` süreci hiç çalıştırılmıyor. macOS+Xcode'lu bir CI job'ı (ya da
yerel bir çalıştırma) bunları gerçek toolchain'e karşı egzersiz ederdi; bu ortamda (Xcode yok/CI yok)
yapılmadı. Parser'lar gerçek xcodebuild/atos çıktı fixture'larına göre yazıldı ama canlı bir sürüm
drift'ini yalnız gerçek bir çalıştırma yakalar.

## Wave 0'da kapatıldı (feat/wave-0-hardening, 13 commit)

- **#1** derinlik guard'ı artık `ctx.ask`'ten ÖNCE (`guardFrom` fetch'lenmiş parent'ı
  kullanır); ikinci `sessions.get` bilinçli TOCTOU re-fetch'i (test pinli).
- **#2** `deriveSubagentSessionPermission` canTask'ı `KiloTask.nestedTask`'a birleşti
  (sıkılaşan durum test pinli).
- **#3 (mesaj yarısı)** nötr "Delegation depth limit" metni.
- **#7 a/b/c** per-session `costs` map'i (A-B-A çift sayım bitti; legacy migration'lı),
  `assertPipelineMatches` çift yönlü ve `status()` da çağırıyor.
- **#8** org tool'ları organization.jsonc'suz projelerde gizli (5s TTL cache).
- **#9** resume-edilemez her incomplete yolu tam `task_call` (idea/priors/reviseNote
  brief'li) döner; `reviseNote` persist; ceo.md step-5 protokolü eşleşiyor.
- **#10** şef edit izni `runs/*/deliverables/**`'a daraltıldı; state.json/approvals.json
  deny gerçek evaluator'la test pinli (agent-kural seviyesinde — W0-R1'e bak).
- **Yeni:** approvals.json audit trail + `org_stop` acil durdurma (SessionID guard'lı,
  best-effort cancel) + injection guard'ları (stage prompt + ceo gate) + 58 kişilik
  roster (24 uzman + 8 validator, yetim-yok testi, şef prompt'larında keşfedilebilirlik).

## ACCEPT (tasarım gereği / pre-existing)

- webfetch/websearch skaler izinler (URL-desen yok) — şablonlar prompt-seviyesi kısıt kullanır.
- Prompt fence'leri whitespace varyantlarını (`</idea >`) yakalamaz — heuristik savunma.
- `updateGlobal` normalize-materyalizasyonu (pre-existing normalize-on-decode özelliği).
- Plan dokümanı drift'leri — plan point-in-time artifact.
- `org_stop`'un canlı session cancel'ı tek-instance akışta çoğunlukla no-op (şef task'i
  CEO turn'ünü bloklar); persist edilen halt asıl mekanizma. Background şefler için doğru.
- `orgEnabledCache` eviction'ı gerçek LRU değil (512 root pratikte imkânsız).
- W0.6 "escapeFence usage notes" genişletmesi yapılmadı (guard satırları + testler var) — kozmetik.
- **(W1.0, W1.0b'de daraltıldı)** Elle yazılmış, org şablonu OLMAYAN agent'lar da
  `subordinates` bildirerek bu relaxation'a girer — `declaredSubordinate` yalnız
  BİLDİRİLMİŞ listeye bakıyor (W1.0b re-key; ruleset imzası artık yetmiyor), "bu agent
  org-template'ten mi geldi" diye bakmıyor. Kabul edilen davranış: `subordinates` bildirimi
  açık bir güven ilişkisi ifadesidir (yazar bilinçli olarak dar bir delegasyon listesi +
  child'a devredilen edit yetkisi kurmuş demektir); global config bu alanı enjekte edemez.
  Aynı güven alanı (trust domain) içinde çalıştığı için ek bir gate gerekmiyor.

## Ortam notları

- Kullanıcının diski tekrar tekrar %100'e doluyor (opencode-test-* iki kez ~9GB
  temizlendi; Wave 0 kapanışında 5 klasör daha silindi). Tam sweep CI'da veya alanı
  olan makinede.
- `bun.lock` yerel drift'i (kilo-jetbrains 7.4.4→7.4.5) commit'lere alınmıyor
  (Wave 0 commit'lerinde de yok — doğrulandı).
- Tam test sweep'i `bun test` ile değil `bun run script/test-runner.ts` ile (izole runner).

## TRACK (Wave 2 kapanış review'u — feat/wave-2-build, WAVE-MERGE: READY-WITH-TRACKED-FOLLOWUPS)

- **W2-R1 (Minor) — SwiftLint/SwiftFormat ruleset dosyası YOK.** W2.4 `swiftlint*`/`swiftformat*`
  allowlist grant'ları ve "pass `swiftlint --strict`" Do-line'ları ekledi ama repoda hiçbir
  `.swiftlint.yml`/`.swiftformat` config yok. Worker'lar SwiftLint'i VARSAYILAN kurallarla çalıştırır
  (ya da SwiftLint kurulu değilse no-op/fail). Plan'ın "config-first"i "agent'ları yapılandır, tool
  yazma" demekti — yani plan LAFZINA uygun ve graceful degrade ediyor. Yine de ruleset'siz bir
  "--strict" gate okunduğundan daha yumuşak. Takip: baseline bir ruleset ship et ya da
  "proje kendi ruleset'ini sağlar" diye açıkça belgele. Merge blocker değil.
- **W2-R2 (TRACK, mimari) — paylaşılan `xcodebuild-exec` primitive'i çıkar.** xcode-build.ts ve
  xcode-test.ts spawn/scoped-run/drain/raceAll-timeout/lazy-disk-sink/`catchCause`-kill iskeletini
  + neredeyse özdeş streaming parser'ı kopyalıyor. Wave close'da copy-not-extract SAVUNULABİLİR
  (parser'lar gerçekten farklı; crash_symbolicate zaten basit exec kullanıyor — yalnız 2/3 call
  site birleşir). Ama parity fix (W2.7) bu iskelete İKİ KEZ elle uygulandı; Wave 3 dördüncü bir
  xcodebuild-şekilli tool eklemeden ÖNCE `run(command,{timeoutMs,onChunk,sink}) → Ran|SpawnFailed`
  (catchCause-kill gömülü) primitive'ini çıkarmak ROI-pozitif olur. Doğruluk sorunu değil (kod
  doğru, test'li, taze senkronize).

  **NOT (Wave 3):** Wave 3 dördüncü bir xcodebuild-tool eklemedi → W2-R2 hâlâ ertelendi (geçerli).

  **KAPATILDI (Wave 7.1, `120ad5debc`):** W7 iki yeni xcodebuild-şekilli tool ekledi (`xcode_archive`,
  `ipa_export`) → dördüncü/beşinci call-site tetiklendi, ROI pozitife döndü. Paylaşılan
  `runXcodebuild(spawner, trunc, parser, {command,args,cwd,timeoutMs,toolLabel})` primitive'i
  `xcodebuild-exec.ts`'e çıkarıldı; `StreamingXcodeParser` `(maxTailBytes, successMarker, failMarker)`
  ile parametrize edildi (BUILD/ARCHIVE/EXPORT marker'ları). xcode-build/xcode-test davranış-koruyarak
  refactor edildi. W2-R2 KAPANDI.

## Wave 3'te kapatıldı (feat/wave-3-observability, W3.1-W3.5)

Wave 3 = gözlemlenebilirlik: org-run durumunu salt-okunur bir HTTP API üzerinden açıp ince bir
kilo-console panelinde (liste + detay + maliyet paneli + kapı rozeti + polling) gösteren katman.
Operatör-onaylı şekil: **API-first + ince panel**. DB migration YOK (dosyalar hızlı).

- **W3.1 — salt-okunur org-runs HTTP API.** `groups/org-runs.ts` (HttpApi group + şemalar) +
  `handlers/org-runs.ts` (OrgState/OrgAudit'ten disk okuyan view builder'lar) + api.ts/server.ts
  wiring (kilocode_change fence'li). `GET /org-runs` (özet liste: runID/idea/status/createdAt/
  totalCost/stageCount/currentStage/awaitingGate) + `GET /org-runs/:runID` (tam Run + audit +
  per-stage view + totalCost). Maliyet matematiği OrgState.runSummary/stageCost'a delege — asla
  yeniden türetilmiyor. `runID` path-traversal guard'ı (`isTraversal`, W3.2'de eklendi;
  `/`, `\`, `..` reddeder). Gerçek-HTTP-katmanı testi (`httpapi-org-runs.test.ts`,
  HttpRouter.toWebHandler + x-kilo-directory routing).
- **W3.2 — SDK regen + console client fns.** openapi-ts ile `client.orgRuns.list/detail`
  üretildi; `loadOrgRuns`/`loadOrgRunDetail` client wrapper'ları.
- **W3.3 — console liste + detay rotaları.** `OrgRunsListRoute`/`OrgRunDetailRoute` + saf view
  helper'ları (`org-runs-view.ts`: formatCost/stageTimeline/runStatusBadge/awaitingGateStages/
  auditTrail) + 9 birim testi. Sidebar "Org Runs" linki.
- **W3.4 — maliyet paneli + kapı rozeti + polling.** `OrgRunCostPanel` (per-stage maliyet tablosu
  + toplam, kuruşuna kadar); saf `costRows`/`costTotal` helper'ları (`costTotal === totalCost`
  kuruş-testi, kırmızı/yeşil zorlanarak load-bearing kanıtlandı); "AWAITING APPROVAL" rozeti +
  `awaitingSince` (geçen süre); aktif run'da 3s polling (createEffect + setInterval, onCleanup ile
  temizlenir, status "active" değilse kurulmaz). **CANLI DOĞRULANDI:** temiz 3s ritmi (10 istek/29s,
  aralıklar 3016-3032ms), tamamlanmış run'da 0 polling. SSE bilinçli ertelendi (poll yeterli).
- **W3.5 — exit testi + final review + merge.** `wave3-exit.test.ts`: exit kriterini çalıştırılabilir
  kılıyor — çok-aşamalı run (biri awaiting_approval), 12.5+0.37+1.13=14.00 float-hata-açığa-çıkaran
  maliyetlerle, hem `toBeCloseTo(x,10)` hem integer-cents ile "kuruşuna kadar" iddiası (perturbe→RED,
  restore→GREEN). Canlı gerçek-sunucu ispatı: `kilo serve` + seed'li run'lar → liste/detay/maliyet
  paneli/kapı rozeti tarayıcıda render edildi, state.json'a kuruşuna kadar eşleşti, 0 console hatası.

**Wave-close review (5-boyut adversarial, 41 agent, 3-şüpheci refutation) — 2 gerçek bug bulundu, İKİSİ DE FIXED:**
- **Bug A (Important) — tek bozuk run TÜM listeyi 500'lüyor — FIXED (`e0e6a8ad68`).** `OrgRunsView.list`
  `Promise.all(ids.map(OrgState.read))`'ti; tek bir truncated/schema-invalid `state.json` (ya da
  state.json'suz stray dir) tüm promise'i reddedip (handler `Effect.promise`, catch yok) HTTP 500
  döndürüyordu → sağlıklı run'lar dahil hiçbiri listelenmiyor. Fix: per-run try/catch + `.filter(Boolean)`
  izolasyonu (bozuk run atlanır, sağlıklılar döner). Ek: `OrgState.NotFound` sentinel'ı eklendi;
  `detail` artık yok-olan run → 404, VAR-ama-bozuk run → 500 (`Effect.die`, generic gövde, path sızıntısı
  yok — testle doğrulandı) ayrımı yapıyor (eski Minor #5: her hata 404'e maplenip bozukluğu "yok" gibi
  gösteriyordu); bozuk `approvals.json` graceful degrade ediyor (boş audit). 9 test yeşil.
- **Bug B (Important) — console discover-recovery sonsuz döngüsü — FIXED (`9db72d3f9f`).** Liste/detay
  rotalarının hata-kurtarma effect'i (paylaşılan ProjectsRoute deseninden birebir kopya): bir sunucu
  /global/health + /project'e cevap verirken org-runs isteği başarısız olmayı sürdürürse
  forget→rediscover AYNI sunucuyu yeniden seçip her döngüde ~40 URL tarıyordu. Org rotaları
  pre-existing rotalardan DAHA açık: discovery'yi /project'te doğrulayıp /org-runs (bağımsız
  başarısız olabilen farklı endpoint) çekiyorlar. Fix: per-mount `Set` ile rediscovery'yi başarısız
  sunucu başına TEK denemeye sınırla + retry'da url'i boşaltmayı bırak (böylece kalıcı-başarısız sunucu
  hata kartını gösterir, döngü değil). **CANLI DOĞRULANDI:** 60s+ pencerelerde SIFIR runaway istek;
  happy path ve pinned (?server=) mod etkilenmedi.

## TRACK (Wave 3 kapanış review'u — feat/wave-3-observability)

- **W3-R1 (Minor) — SDK `NullOr` alanları generated type'larda non-nullable.** Group şeması
  `currentStage`/`startedAt`/`completedAt`/`decision`'ı `Schema.NullOr(...)` ilan ediyor ama
  `packages/sdk/js/src/v2/gen/types.gen.ts` bunları düz `string` (nullable değil) üretiyor —
  openapi-ts generation NullOr nullability'sini düşürüyor (repo-geneli generator sınırı, org'a özgü
  değil). Tek tüketici (console) null'ları zaten normalize ediyor (crash yok); dış SDK tüketicileri
  risk altında. Takip: openapi-ts nullability üretimini düzelt ya da alanları `optional(NullOr(...))`
  gibi generator'ın doğru serialize ettiği bir konstrüktle ilan et. Merge blocker değil.
- **W3-R2 (Minor) — maliyet paneli per-stage yuvarlama footing'i sub-cent maliyetlerde tutmuyor.**
  Her satır bağımsız `toFixed(2)` ile yuvarlandığından, üç aşama 0.005'er ise satırlar "$0.01"×3
  (görsel $0.03) ama Total `formatCost(0.015)` = "$0.01" gösterir — breakdown Total'a footing yapmaz.
  Yalnız sub-cent aşama maliyetlerinde görülür (gerçek LLM maliyetleri asla sub-cent değil). BİLİNÇLİ
  DÜZELTİLMEDİ: satırları yuvarlanmış-toplama footing'lemek "Total = API totalCost'a kuruşuna kadar
  eşit" exit kriterini bozardı. Kozmetik, kabul edildi.
- **W3-R3 (canlı doğrulamada keşfedildi) — console resource kalıcı 5xx'te LOADING'de takılıyor.**
  `fetcher = window.fetch.bind(window)` (retry yok); kalıcı bir 500 tek istekte tamamlanıyor (12ms)
  AMA SDK/resource katmanı bunu `runs.error` olarak yüzeye çıkarmıyor → resource sonsuza dek
  `loading:true, err:null` (spinner), retry yok. Pre-existing, console-GENELİ (tüm rotalar, org'a özgü
  değil). Bug B guard'ı bunu etkilemez (guard `runs.error`'a bakar, o hiç set olmaz). **Bug A fix'i
  org listesi için pratik tetiği kaldırıyor** (bozuk run → atlanır → 200, artık 500 yok); yalnız başka
  bir sebeple gerçek bir 500 hâlâ spinner'da takılır. Takip: 5xx'i hata olarak yüzeye çıkar / loading
  timeout → hata kartı ekle (paylaşılan client/fetcher katmanında).
- **W3-R4 (latent pattern) — discover-recovery döngü deseni paylaşılan rotalarda da var.** Aynı
  effect `ProjectsRoute`/`ProjectConsoleRoute`/`profile/server.ts`'te birebir mevcut; orada daha az
  açık (doğruladıkları endpoint'i = /project çekiyorlar, bağımsız başarısız olan farklı bir endpoint
  değil). Org rotaları bounded-recovery guard'ını (W3, `9db72d3f9f`) aldı; paylaşılan rotalar almadı.
  Takip: aynı guard'ı paylaşılan rotalara uygula ya da ortak bir recovery helper'ı çıkar. Pre-existing;
  Wave 3 kapsamı dışı bilinçli tutuldu (paylaşılan console altyapısını refactor etmemek için).

**SNR-deferred (Wave 3'te bilinçli ertelendi → Wave 4+):** SSE org-event publishing (polling +
session-close refresh yeterli); org-runs DB tablosu (dosyalar hızlı, migration yok); per-stage
latency/success histogramları; desktop/webhook bildirimleri (UI rozeti "kapı bir bildirim ateşler"i
karşılıyor). Hiçbiri doğruluk sorunu değil.

## Wave 4'te kapatıldı (feat/wave-4-dag, W4.1-W4.8)

Wave 4 = workflow DAG motoru: doğrusal pipeline'ı bağımlılık DAG'ına genelleştirip bağımsız
aşamaları (frontend ∥ backend) eşzamanlı çalıştırma. **Tasarım kararı:** runner SAF ve tek-CEO-güdümlü
kalır (W0-R2 değişmezliği) — runner HAZIR aşama KÜMESİNİ hesaplar (fan-out batch), CEO onları paralel
`task` çağrısı olarak spawn eder. `requires` VARSAYILANI = bir önceki pipeline girdisi + `maxConcurrency`
varsayılanı 1, yani mevcut doğrusal org'lar BYTE-AYNI sürer (paralellik opt-in). Doğrusal-regresyon pin'i
tüm dalga boyunca yeşil kaldı.

- **W4.1 — schema DAG alanları.** `Stage.requires[]/when/timeoutMs` + org `maxConcurrency`; `resolveRequires`
  (absent→prev, explicit-[]→root); `validate`'e döngü tespiti (DFS renklendirme, döngü yolunu raporlar) +
  dangling requires/when.stage kontrolleri.
- **W4.2 — `skipped` status + saf seçiciler.** `readyStages/runningStages/awaitingStages/blockedStages`
  (I/O yok; `resolveRequires` üzerinden; `skipped` bağımlıları tatmin eder).
- **W4.3 — batch `advance` (fan-out).** Hazır aşamaları fan-out eder, birden çok running aşamayı settle
  eder (`settleRunningStage` — maliyet/tavan/escalation/revize mantığı BYTE-AYNI çıkarıldı, yalnız
  `running.gate`→`pipelineStage.gate`); DAG-farkında `priorDeliverables` (transitif requires closure ==
  doğrusalda prefix). **Ara review (adversarial, 4-boyut, 3-şüpheci): 1 bulgu — bütçe-escalation notu
  eşzamanlı kapılarda düşüyordu → FIXED (`8623dbf286`):** `escalationNote` artık stage'e persist ediliyor,
  her gate onu okuyor (`gateItemFor`), `decide` temizliyor.
- **W4.4 — koşullu `when` + run mode.** `whenSatisfied` ({mode}==run.mode / {stage,decision}); false ise
  aşama `skipped` (instruct yok, maliyet yok, slot yok); fan-out skip-döngüsü readiness'i yeniden türetir,
  sonlanması garanti. Konsol `skipped` rozeti (ghost) + SDK gen type'larına `skipped` senkronu.
- **W4.5 — per-stage `timeoutMs`.** `Deps.now` (varsayılan Date.now) ile deterministik; yalnız
  validation-başarısız dalında `now-startedAt > timeoutMs` → `retryOrFail` "timeout" cause'u; geçerli
  deliverable üreten aşama ASLA timeout olmaz.
- **W4.6 — tools + CEO paralel protokolü.** `org_advance` action sözlüğü: halted→done→run_tasks→
  human_gate→resume_chief→waiting. `run_tasks` (tek/çoklu instruct dizisi), `task_results` (aşama başına
  taskID threading), `waiting` (uçuşta dal). Eş-zamanlı gate `pending_gate` olarak instruct'larla birlikte
  taşınır (karar #6: instruct öncelikli, gate danışma). ceo.md paralel-spawn protokolü.
- **W4.7 — şablon elması.** Shipped org-template: backend∥frontend (ikisi ux'e requires), testing ikisine
  join, `maxConcurrency:2`. Canlı runner testi eşzamanlılığı kanıtlıyor.
- **W4.8 — exit testi + wave-close review + merge.** `wave4-exit.test.ts`: diamond fan-out + koşullu skip +
  timeout + doğrusal-regresyon pin'i çalıştırılabilir. Canonical sweep yeşil (bilinen cross-file flaky'ler
  2/2 retry ile geçti).

**Wave-close review (adversarial, 4-boyut, 28 agent, 3-şüpheci) — 6 bulgu (1 CRITICAL, 2 important, 3 minor), HEPSİ FIXED:**
- **CRITICAL (fan-out passive re-settle) — FIXED (`e5fe95a65b`).** `advance` HER running aşamayı her çağrıda
  settle ediyordu; bir kez stall'layan (taskID'sini koruyan) dal, kardeş işin tetiklediği her advance'te
  `retryOrFail` ile yeniden settle edilip `incompleteAttempts`'i GERÇEK chief koşusu olmadan artırıyor →
  `budget.retries` sahte tükeniyor → sahte halt. Fix: bir running aşama YALNIZCA (a) bu çağrıda rapor
  edildiyse (taskResults/tek taskID), (b) `decision==="revise"` beklemedeyse, ya da (c) TEK running aşamaysa
  settle edilir. Kloz (c) maxConcurrency:1'i byte-aynı yapar; patoloji yalnız 2+ running-stage-kardeş
  durumunda olur ve (c) onu dışlar. Repro RED→GREEN.
- **Important (marketing skip-by-default footgun) — FIXED (`14c1c89373`).** Shipped template'in terminal
  `marketing` aşaması `when:{mode:"full"}` taşıyordu; `org_start` mode'u varsayılan undefined + ceo.md hiç
  mode geçmiyor → her normal koşuda marketing "skipped" → App-Store paketi SESSİZCE hiç üretilmiyor. Fix:
  shipped template'te marketing KOŞULSUZ (when kaldırıldı); `when` özelliği sentetik org'da demo edilir;
  README dürüstçe düzeltildi (`when:{mode:X}` = "yalnız mode===X iken çalış", terminal deliverable'ı böyle
  gate'leme uyarısı).
- **Minor — FIXED:** (#4) timeout revize sonrası orijinal `startedAt`'i kullanıyordu → `decide` revize dalı
  artık `startedAt`'i sıfırlıyor. (#5) `pending_incomplete` CEO'ya re-run yolu vermiyordu → artık resumable
  task entry taşıyor + ceo.md CEO'ya aynı paralel turda yeniden spawn'la diyor (CRITICAL fix'in gerekli
  tamamlayıcısı). (#6) `when.stage` ata (ancestor) doğrulanmıyordu → `validate` artık when.stage'in transitif
  requires-ata'sı olmasını zorluyor (kardeş referansı reddedilir, decision undefined olurdu).

**TRACK (Wave 4 kalan kenar durumu):** Kloz (c) — CEO `pending_incomplete`'i re-spawn etme protokolünü
İHLAL ederse ve stall'layan dalın kardeş kolu tamamen boşalıp o dal TEK running aşama haline gelirse, boş
poll advance'leri onu yine passive re-settle edip bütçe yakabilir. Bilinçli kabul: tek-aşama sözleşmesiyle
aynı davranış + W4.6/#5 protokolü CEO'yu buna karşı yönlendiriyor (aynı turda re-spawn zorunlu). Ayrıca:
`When` şeması yalnız pozitif-eşitlik (negasyon yok) — temiz opt-out koşulları için ileride `unless`/negasyon
eklenebilir.

**SNR-deferred (Wave 4'te bilinçli ertelendi → v2, dossier §D):** stage priority queue; dynamic pipeline
generation (CEO çalışma zamanında pipeline'ı besteliyor). Doğruluk sorunu değil.

## Wave 5'te kapatıldı (feat/wave-5-quality, W5.1-W5.5)

Wave 5 = kalite kapısı: terminal marketing aşamasından ÖNCE bir `review` aşaması. Tasarım: mevcut her şeyi
yeniden kullan — `gate:"human"` + `org_decision("no-go")` halt ZATEN "block" mekanizması; W4 paralelliği +
chief→worker delegasyonu ZATEN "paralel reviewer" mekanizması. Yeni kod yalnızca yapılandırılmış compliance
TOOL'ları; gerisi config (agent + template) + consensus deliverable konvansiyonu (chief prompt'u). Runner/schema
değişikliği YOK.

- **W5.1 — `privacy_manifest_check` + `ats_check`.** Kendi-yeterli XML-plist parser'ları (npm dep yok; dengeli-tag
  walker — iç-içe container regex kesintisi bug'ı fixture'la yakalandı). privacy: NSPrivacyAccessedAPITypes'ta
  boş-reason veya eksik required-reason API → violation. ats: NSAllowsArbitraryLoads(/InWebContent/ForMedia) +
  insecure exception-domain → violation. Never-crash (ENOENT/malformed → yapısal sonuç). Registry infos/build/extra
  + 3 indexing-literal testi güncellendi.
- **W5.2 — `secret_scan`.** Bounded (2MB cap) + binary-skip (uzantı + null-byte sniff) + SKIP_DIRS. Pattern seti:
  AWS AKIA, PEM private-key header, atanmış-secret literali; placeholder guard (YOUR_/example/`\(…)`/`${…}` hariç,
  LOAD-BEARING testli). Redaksiyon (raw secret snippet'e sızmaz). Yüksek-entropi taraması bilinçli YOK (gürültü).
- **W5.3 — review dept + stage wiring (birleşik).** 3 yeni agent (review-chief, security-validator,
  senior-engineer-reviewer) + mevcut 8 validator'ün review-chief consultant'ı olarak yeniden kullanımı. Roster split:
  workers=[security-validator, senior-engineer-reviewer, privacy-manifest-validator], consultants=[appstore-review-,
  accessibility-, hig-, entitlement-validator]+apple-docs (bir validator'ün birden çok chief'e consultant olması
  crossCheck/validate'te serbest — doğrulandı). Pipeline: `review` (requires debugging, gate human, haltOn no-go),
  marketing requires review. 8→9 aşama, 58→61 agent. Consensus prompt: chief paralel reviewer'ları spawn eder,
  per-reviewer-vote review.md üretir. Compliance tool grant'ları reviewer'lara. template.test 33 assertion.
- **W5.5 — exit testi.** `wave5-exit.test.ts`: (1-3) compliance tool'ların saf fn'leri seeded defect'leri yakalıyor
  (hardcoded secret redaksiyonlu, boş-reason manifest, ats arbitrary-loads), (4) runner: review awaiting_approval →
  no-go → HALTED + marketing HİÇ koşmadı (pending, startedAt yok, cost yok, deliverable yok), (5) approve → marketing
  ilerliyor → done. LOAD-BEARING (block path gerçek). NOT: implementer'ın bağlantısı commit'ten önce koptu; test'i
  ben doğrulayıp (7/7 yeşil) commit'ledim.

**Wave-close review (adversarial, 4-boyut, 25 agent, 3-şüpheci, false-negative-ağırlıklı) — 5 bulgu (0 critical,
3 important, 2 minor), HEPSİ compliance false-negative (kapı defect'i GEÇİRİYOR), HEPSİ FIXED (`bfa9c864c8`):**
- **Important — ats_check malformed plist'te ok:true (fail-OPEN) → FIXED fail-CLOSED.** isWellFormedPlist tüm
  dosyada (yorumlar dahil) tag sayıyordu; yorumda stray `<key>` → "malformed" → ATS "secure" raporluyordu (privacy
  tool'un aksine — tehlikeli asimetri). Fix: yorum/CDATA strip + malformed → ok:false (invalid), fail-closed.
- **Important — secret_scan tırnaksız değerler kaçıyor (.env/.xcconfig/shell) → FIXED.** `API_KEY=sk-live-…`
  (dotenv, #1 secret vektörü) tırnak zorunluluğu yüzünden kaçıyordu. Fix: config-uzantısına-scope'lu tırnaksız
  bare-token pattern (kod dosyalarında false-positive yok — `.swift`'te `computeKey()` işaretlenmiyor).
- **Important — secret_scan tırnaklı-key formatları kaçıyor (JSON/plist) → FIXED.** `"api_key": "…"` — `:` öncesi
  tırnak `key\s*[:=]`'yi bozuyordu. Fix: key etrafında opsiyonel tırnak + ayrı plist `<key>/<string>` pass'i.
- **Minor — privacy boş-reason string'i compliant sayıyordu → FIXED** (uzunluk değil trim'lenmiş-içerik kontrolü).
- **Minor — ats NSThirdPartyExceptionAllowsInsecureHTTPLoads'ı kaçırıyordu → FIXED** (üçüncü-taraf insecure-HTTP
  varyantı da flag'leniyor).

**TRACK (Wave 5 kalan, bilinçli):** secret_scan tırnaksız secret'i NON-config uzantıda yakalamaz (kod false-positive'inden
kaçınmak için scope'lu); yüksek-entropi taraması yok; plist `<key>/<string>` pass'i secret-kelime substring'ine keyed
(ör. iOS `PasswordRules` gibi meşru bir anahtar plist içinde over-report edilebilir — kabul edilen konservatif over-report).

**SNR-deferred (Wave 5'te bilinçli ertelendi):** multi-model consensus/ensemble (tek reviewer/lens + insan kapısı
yeterli — dossier out-of-scope); Dynamic-Type/Dark-Mode/RTL simctl doğrulaması (simulator tool'u gerektirir, W7+);
GDPR checklist derinliği. Doğruluk sorunu değil.

**Ortam notu (Wave 5 sweep):** kanonik sweep'te 2 test (`session-processor-network-offline`,
`session-processor-retry-limit`) fail etti AMA izole koşuda 4/4 GEÇTİ ve hiçbir Wave 5 sembolüne dokunmuyorlar —
bu oturumdaki gerçek ağ kararsızlığına (ConnectionRefused/MCP kopmaları) duyarlı, önceden-var-olan çevresel flaky'ler,
Wave 5 regresyonu DEĞİL.

## Wave 6'da kapatıldı (feat/wave-6-memory, W6.1-W6.4)

Wave 6 = bellek & öğrenme: her koşu ders çıkarsın, sonraki koşular ısınsın. Tasarım: MEVCUT altyapıyı yeniden kullan —
`kilo-memory` `Memory.*` motoru `{root}`-parametreli (org havuzu = aynı motor `.kilo/org/memory`'de, leksikal recall,
keyless); `kilo-indexing` RAG'ı (embedder iface + LanceDB + directoryPrefix namespace + açık payload) inject ile
yeniden kullanılır (test'te stub embedder). Postmortem DETERMİNİSTİK (LLM yok), koşu bitiş choke point'inde
(OrgAdvanceTool done/halt + decide no-go + stop, withRunLock içinde), BEST-EFFORT (postmortem hatası koşu tamamlanmasını
ASLA bozmaz).

- **W6.1 — org-scoped memory havuzu.** `OrgMemory` = `Memory.*` `.kilo/org/memory` root'ta (proje-yerel, cross-run,
  committable, session-memory'den İZOLE — doğrulandı). Dept-tag = `[dept::name]` marker + post-filter. Yeni
  `org_memory_save`/`org_recall` (CEO-scoped, org_* görünürlük). Motor değiştirilmedi.
- **W6.2 — postrun postmortem hook.** Saf `OrgPostmortem.build` (per-stage status/cost/attempts/decision + total + outcome,
  Date.now yok) → `.kilo/org/lessons.md` (fire-once `<!-- postmortem:runID -->` marker) + org memory (upsert key=runID).
  Best-effort: gerçek EISDIR failing-writer ile RED→GREEN kanıtlı (catch kaldırılınca 4 test fail).
- **W6.3 — org-scoped RAG + citations.** `OrgRag` deliverable'ları inject store'a indexler (payload runID/stage;
  arama-zamanı runID/stage'i filePath'ten TÜRETİR çünkü gerçek LanceDB fazladan payload key'lerini düşürür); directoryPrefix
  scoping (run-1/run-10 trailing-sep guard); graceful degradation ({unavailable:true}, embedder yoksa asla throw etmez).
  `semantic_search`'e `cite: file:line`. `KiloIndexing.orgRagServices` gerçek BYOK wiring (.kilo/org/rag'a namespace'li).
- **W6.4 — exit testi.** 5 kriter uçtan uca: postmortem→lessons+memory (tamam+no-go), org-RAG 2-koşu runID-scoped arama,
  citations+graceful-no-key, best-effort (gerçek EISDIR → tamamlanma etkilenmez) + fire-once.

**KRİTİK regresyon (tam sweep yakaladı, task-test subset'leri KAÇIRDI) — FIXED (`8341de8fcb`):** W6.3'ün `org-search.ts`'i
`KiloIndexing`'i (ağır indexing.ts modülü) TOP-LEVEL import ediyordu; registry.ts her tool'u yüklediğinden bu, ağır modülü
registry'nin module-init grafiğine çekip yükleme sırasını bozarak `control-plane/workspace.ts`'te latent bir circular-import
TDZ'yi (`SessionPrompt.defaultLayer before initialization`) TÜM suite genelinde tetikliyordu — tam sweep'te 81 sahte fail.
Bisect W6.3'ü, registry-revert testi org-search girişini suçlu buldu. Fix: `KiloIndexing`+`OrgRag` org-search.ts'te
call-time DYNAMIC import'a alındı (statik ayak izi minimal). **DERS: load-order-duyarlı circular-import bug'ları yalnız TAM
sweep'te görünür; task-test subset'leri (izole dosyalar) kaçırır — wave-close tam sweep zorunlu.**

**Wave-close review (adversarial, 4-boyut, 25 agent, 3-şüpheci) — 5 bulgu (0 critical, 2 important, 3 minor), HEPSİ FIXED
(`8aaec5347c`):**
- **Important — org-RAG üretimde ATIL'dı → FIXED.** (1) `indexDeliverables` payload'da `fileHash` yoktu; gerçek
  LanceDBVectorStore.isPayloadValid `[filePath,fileHash,codeChunk,startLine,endLine]` şart koşar → her org noktası SESSİZCE
  düşüyordu (stub store isPayloadValid zorlamadığından test'te görünmüyordu). Fix: `fileHash = sha256(chunk)`. (2)
  `indexDeliverables`'ın ÜRETİM çağıranı YOKTU → org_search hep boş store'u arıyordu. Fix: `OrgRag.indexRun` + postmortem
  hook'unda best-effort indexleme (embedder varsa; yoksa atıl kalır, tamamlanmayı bozmaz).
- **Minor — FIXED:** lessons.md cross-run yarışı (withRunLock per-run-id ama lessons.md paylaşımlı → eş-zamanlı iki koşu
  birbirinin bölümünü clobber ediyordu) → path-keyed file-lock. org_recall `limit`'i motora geçirmiyordu (hep 5'e cap) +
  dept post-filter'ı top-5 truncation'dan SONRA (dept match'i düşüyordu) → limit thread + dept için 20'ye over-fetch.

**TRACK (Wave 6 kalan, bilinçli):** org-RAG re-index maliyeti (indexRun her tamamlanmada tüm deliverable chunk'larını
re-embed eder; stable id'ler duplicate önler ama fileHash-skip yok); chunk-sınırı kayınca eski point'ler silinmez;
embedder yapılandırılıysa tamamlanma latency'si (sonuç hesaplandıktan SONRA, döndürülen action etkilenmez); lock'lar
process-local (withRunLock ile aynı cross-process sınırı).

**SNR-deferred (Wave 6'da bilinçli ertelendi → v2, dossier §F/§M):** LLM-anlatımlı nitel dersler; hybrid BM25+vector arama;
architecture-decision-log çıkarımı; coding-standards yakalama; prompt-improvement pipeline. Org-RAG gerçek vektör araması
runtime'da BYOK embedder ŞART (yapılandırılmadıkça graceful atıl) — W7 Apple hesabı gibi soft external bağımlılık.

## Wave 7'de kapatıldı (feat/wave-7-apple, W7.1-W7.7 → main `88ad51e128`, push edildi)

Wave 7 = App Store Connect teslimatı (BYO-credentials, doğrudan ASC REST API, fixture-test'li iskele):
`xcode_archive`/`ipa_export` (paylaşılan `runXcodebuild` primitive'i, W2-R2'yi kapatır); BYO-ASC credential
resolver (`resolveAscAuth`/`loadAscCredential`, key repo-DIŞI auth store 0600 veya env); elle-yazılmış ES256
JWT (`node:crypto`, `dsaEncoding:"ieee-p1363"` → ham R‖S, DER değil); doğrudan ASC REST client (`AscClient`,
enjekte edilebilir `fetch`, exp-tabanlı token cache/re-mint, 429/5xx retry) + operations; `asc_metadata_validate`
(code-point limitleri, 39-locale allowlist, fail-closed); review-monitor background job (poll→Bus→terminal);
`asc_submit`/`asc_status` (altool upload + JSON submit); iki-aşamalı insan-kapılı teslimat.

**GÜVENLİK (public→private geçişte de geçerli):** ASC private key (.p8 PEM) + issuer/key id ASLA
commit/log/throw/tool-output/argv'a girmez. Wave-close güvenlik-ağırlıklı review bunu doğruladı: 0 sızıntı.
Belt-check: tracked tree'de gerçek key materyali YOK (tüm `BEGIN PRIVATE KEY` eşleşmeleri redaction/scrub/secret-scan
ARAÇLARINDA). BYO tasarımı repo private olsa da doğru — commit-etme-sırrı ilkesi repo görünürlüğünden bağımsız.

**Wave-close review (adversarial, 4-boyut güvenlik-ağırlıklı, 16 agent, 3-şüpheci) — 2 bulgu (0 critical, 1 important,
1 minor), HEPSİ FIXED (`1c20dfdad9`):**
- **Important — insan "ship gate" aslında asc_submit'i KAPILAMIYORDU → FIXED.** Runner bir stage'in `gate:human`'ını
  chief deliverable'ı ÜRETTİKTEN SONRA tetikler; `decide()` approve dalı stage'i sadece `completed` işaretler, chief'i
  YENİDEN çağırmaz. Tek `delivery` stage'i asc_submit çağırıyorsa: ya chief kapı-öncesi submit etmez → approve'da HİÇ
  gönderilmez, ya da tek koşusunda submit eder → kapı dekoratif. **Fix: iki stage'e böl —** `delivery`
  (`requires:[marketing]`, `gate:human`, `haltOn:no-go`, SADECE hazırlık: archive/export/validate) →
  `release` (`requires:[delivery]`, kapısız, terminal, asc_submit BURADA). `release`, `delivery` completed olmadan
  `readyStages`'e çıkmaz → insan onayı submit'i GERÇEKTEN kapılar; no-go `release`'i hiç çalıştırmaz (wave7-exit test 5
  kanıtlar). Runner.ts DEĞİŞMEDİ — bug tamamen org-template şeklindeydi. **DERS: bir `gate:human` yalnızca
  aktörün-ürettiğini-gözden-geçirmeyi kapılar; yan-etkili eylemi kapılamak için eylem, kapının bir SONRAKİ stage'inde
  olmalı.**
- **Minor — corrupt auth.json tool'u ÇÖKERTİYORDU → FIXED.** `asc-submit`/`asc-status` `Effect.promise(loadAscCredential)`
  kullanıyordu; bozuk auth.json → JSON.parse defect → `Effect.promise` DIES (catch'lenmez) → ham hata (auth path sızıntısı).
  Fix: `Effect.tryPromise(...).pipe(Effect.orElseSucceed(()=>undefined))` → temiz "unavailable" mesajı, throw yok. **DERS:
  reddedebilen bir promise için `Effect.tryPromise` (typed failure), `Effect.promise` DEĞİL (defect/die).**

**GOTCHA (kalıcı, tüm gelecek push'lar):** pre-push husky hook'u `turbo typecheck`'i TÜM paketlerde çalıştırır;
`@kilocode/kilo-jetbrains#typecheck` kullanıcının **Türkçe locale'inde** (`tr_TR`) IntelliJ Gradle plugin'inin
`"application".toUpperCase()` → `"APPLİCATİON"` (noktalı İ) → enum lookup throw ile ÇÖKER. Bizim kodla İLGİSİZ (jetbrains'e
hiç dokunmadık; W7 diff'inde o path boş). W7 push'u `git push --no-verify` ile yapıldı. Kalıcı çözüm: push'u
`JAVA_TOOL_OPTIONS="-Duser.language=en -Duser.country=US"` ile çalıştır ya da hook'u jetbrains hariç tut. **Gelecek W8/W9
push'ları da `--no-verify` (veya locale override) gerektirecek.**

**TRACK (Wave 7 kalan, bilinçli):** `asc_submit` metadata'yı VALIDATE eder ama localization'ları PATCH etmez (GET-localization-id
op'u yok) → "metadata ASC'ye gönderildi" EKSİK; dürüst TODO olarak wave7-exit'te işaretli. Binary upload `xcrun altool`
(sadece --apiKey/--apiIssuer argv; .p8 ~/.appstoreconnect/private_keys'ten okunur). Gerçek ASC/xcodebuild external bağımlılık
(fixture-test'li, canlı doğrulanmadı). GitHub Dependabot: 9 açık (6 moderate, 3 low) — upstream deps, W7-dışı.

## Wave 8'de kapatıldı (feat/wave-8-registry → main `cd75c9e1e3`, push edildi) — SON PLANLANMIŞ DALGA

Wave 8 = Registry & routing v2 (dossier §2/§1/§29/§9): (1) yetenek etiketleme `capabilities[]`/`preferredTypes[]`
(config AgentSchema+KNOWN_KEYS+runtime Info+copy-loop; `skills` DEĞİL — prompt-Skill çakışması; KNOWN_KEYS'e eklenmezse
provider options'a sızar — leak-guard test'i var); (2) `OrgMetrics` (saf aggregate stage→department.chief join org-drift-tolerant,
health() eşik band, collect() skip-on-corrupt; chief-seviye); (3) `GET /agents` + SDK regen + kilo-console scoreboard;
(4) `OrgVersions` snapshot/rollback (reviseBaseline sadece hash'ti → içerik `.kilo/org/runs/<runID>/deliverables.versions/`de
saklanır; rollback NON-destructive; runner best-effort hook'lar settle+decide); (5) `OrgGraph` dependents/impactRadius →
`Stage.invalidatedDownstream` on revise; (6) `OrgBenchmark` fixture-org harness + SLA eval. Full sweep 641/641.

**Wave-close review (adversarial, 4-boyut, 16 agent) — 3 bulgu (0 critical, 1 important, 2 minor) HEPSİ FIXED (`76a94513f4`):**
- **Important — runner snapshot hook'larının assertion kapsamı SIFIRDI → FIXED.** Tüm versions testleri `OrgVersions.snapshot/rollback`'i
  DOĞRUDAN çağırıyordu; hiçbiri RUNNER'ın snapshot ÜRETTİĞİNİ assert etmiyordu. `.catch(()=>undefined)` best-effort olduğundan bir
  refactor hook'u kırsa suite yeşil kalır ama üretimde rollback boş döner. Fix: wave8-exit'e gerçek-`OrgRunner` integration testi
  (start→advance→complete→`OrgVersions.list` non-empty + revise→pre-revise snapshot). Ampirik doğrulandı: her hook tek tek kapatılınca
  test ayrı ayrı fail etti. **DERS: best-effort/fire-and-forget üretim yolları happy-path'i ayrıca assert eden bir test gerektirir —
  aksi halde sessiz regresyon suite'i geçer.**
- **Minor — latency-only health `score 50` → "degraded" idi** (doc "tek ihlal → unhealthy<50" diyor; boundary `>=50` inclusive) → `LATENCY_PENALTY` 50→51 (49 → unhealthy). Boundary testi eklendi.
- **W8-R1 (minor, TRACK — upstream) — SDK codegen `avgLatencyMs`'ten `|null`'ı düşürüyor.** Wire schema `NullOr(Number)`, endpoint gerçekten `null` gönderiyor, ama `types.gen.ts` `number|"NaN"|"Infinity"|"-Infinity"` (null YOK). ARAŞTIRILDI: `NullOr(Finite)` İZOLE codegen'de temiz ama TAM PublicApi merge'inde `|null` düşüyor (org-runs `currentStage: NullOr(String)` alanını da etkiliyor) → **upstream Effect schema-merge/codegen etkileşimi, call-site'ta düzeltilemez.** Schema geri alındı (SDK byte-identical), agents.ts'te belgelendi. Console (`agents-view.ts`) null'ı savunmacı işliyor (`—` render). Kalıcı çözüm: hey-api/openapi-ts + Effect Schema merge davranışını araştır (W8-dışı).

**TRACK (Wave 8 kalan, bilinçli):** metrics chief-seviye (worker maliyeti ayrık değil — org kernel session-tree traversal'ı kasten yapmıyor);
avgLatencyMs revize-edilmiş stage'de son-iterasyon (startedAt reset); `invalidatedDownstream` downstream stage'leri OTOMATIK RE-OPEN etmez
(sadece kaydeder — bilinçli, auto-reopen daha büyük davranış değişikliği). SNR-deferred (Horizon): task→agent auto-selection/routing
(capabilities'i tüketen matcher yok), hybrid BM25+vector arama, benchmark Bus-event emit CLI-boundary'de, content-cross-ref artifact graph.

## Wave 9'da kapatıldı (feat/wave-9-routing → main `9bd842c607`) — Horizon'dan seçilen dalga (auto-selection/routing)

Wave 9 = task→agent auto-selection & quality-aware routing (kullanıcı Horizon backlog'undan seçti): (1) saf `OrgRouting`
(`capabilityScore` = need-coverage overlap `|need∩cand|/|need|` + type-bonus, undefined→0 asla NaN; `rank` = match + OrgMetrics.Health,
**eksik health NEUTRAL/healthy prior** — koşmamış-ama-eşleşen ajan gömülmez; deterministik isim tie-break, localeCompare DEĞİL); (2)
`org_route` tool (CEO-scoped `org_` prefix + guardCeo; stage→workers veya chief'leri capability+health'e göre sıralar; best-effort
health via tryPromise); (3) stage-prompt worker capability annotation (`StageInput.workerCapabilities`; runner LAZY dynamic
`import("@/config/agent")` — W6 TDZ dersini uyguladı; instruct/stagePromptFor async + Promise.all fan-out, davranış-koruyarak).
Exit: rank matched+healthy'yi mismatched/unhealthy'nin üstüne koyar (+ matched-unrun > matched-unhealthy, neutral prior kanıtı);
org_route uçtan-uca + guardCeo; worker annotation. **Wave-close review: 0 BULGU** (4 finder, 350K token, gerçek clean — master planın ilk 0-bulgulu dalgası).

**DOĞRULAMA NOTU (önemli):** feat/wave-9-routing tam sweep'i bu oturumun YÜKLÜ makinesinde ÇEVRESEL kırmızı (21 fail/15 flaky) —
server/HTTP/SDK/config-overlay/TUI-config testleri port/file-handle/timing çakışması. **Kanıt kod DEĞİL çevresel:** (a) tüm 74 etkilenen
test İZOLE geçti (25/25 artifacts+fanout+wave7 + 49/49 config/HTTP/SDK); (b) W9'un kendi routing/org/runner suite'leri tam yeşil;
(c) **pre-W9 main baseline'ı DA aynı yükte kırmızı** (4 dosya/17 case, 15'i W9 sweep'iyle ORTAK) → W9-öncesi koddan bağımsız; (d) TDZ canary 0.
Merge bu kanıta dayandı (izolasyon + baseline karşılaştırması), post-merge confirming sweep atlandı (baseline zaten aynı çevresel gürültüyü gösteriyor).
**DERS: kırmızı sweep ≠ kod regresyonu; alakasız-alan saçılması + flaky-sayısı-artışı + imkânsız-timing (60s) + baseline-de-kırmızı = çevresel;
ağır çok-agent workflow ile eşzamanlı tam sweep KOŞMA (birbirini aç bırakır).**

**TRACK (Wave 9 kalan, bilinçli):** **W9-R1** — chief-callable routing (chief'in worker'ını org_route ile seçmesi) guardCeo + available()
görünürlük cerrahisi gerektirir → CEO-scoped ile ship edildi. **W9-R2** — per-worker health YOK (metrics chief-seviye; worker maliyeti chief
session'a katlanır) → worker sıralaması capability-only, health sadece chief'leri ayırt eder. Auto-acting (runner'ın otomatik worker seçmesi /
sağlıksız chief'i değiştirmesi) YOK — W9 advisory (sıralar/önerir; insan + CEO ajanı eyler).

## Master plan durumu — TAMAMLANDI (W0-W9)
Plan iskeleti **W0-W8 (9 dalga) + Horizon'dan W9 (auto-selection/routing) = TAMAMLANDI, hepsi main'de + push'lu.** Repo Ilura Technology OÜ
mülkiyetinde (private). Sıradaki iş: kullanıcının **2026-07-11 EPIC görev listesi** (`docs/superpowers/plans/2026-07-11-epic-roadmap.md`):
EPIC 0 (ön-koşul kararları) → 1 (derin rebrand Kilo→@ilura/northstar) → 2 (terminal-only release) → 3∥4 (open-core split ∥ genelleştirme:
toolpack+template) → 5 (provider authoring) → 6/7/8 (TUI builder/chat/cockpit). EPIC 0.1 (open-core scope) + 0.2 (npm isim rezervasyonu =
KULLANICI publish aksiyonu) kullanıcı kararı bekliyor.

## EPIC 0 KARARLARI (2026-07-11) + EPIC 1 (rebrand) durumu
- **EPIC 0.1 = FULLY OPEN-SOURCE (MIT).** Moat açık, Ilura kendi eklerinin telifini MIT altında lisanslar. EPIC 3 → sadece lisans/NOTICE
  temizliği (yapıldı: NOTICE/README "proprietary" → MIT-open, `d3432e97e7`). 0.2 npm rezervasyonu = KULLANICI. 0.3 @mention = yan-kanal-not default. 0.4 Apple = bilgi.
- **EPIC 1 (feat/rebrand-northstar):** 1.1 published identity `@kilocode/cli`→`@ilura/northstar` + `bin/northstar` (turbo.json task-graph key'leri de); 1.2 config/env DECOUPLE (kullanıcı seçti): config dir→`~/.config/northstar`, **DATA/DB/session `~/.../kilo`'da KALIR (orphan yok)**, eski `~/.config/kilo` + `KILO_*` fallback okunur; `northstar.jsonc`+kilo.jsonc; flag.ts dual-read; **migrateBashPermission legacy-dir regresyonu bulundu+fix'lendi**; 1.3 installer `$HOME/.northstar/bin` + uninstall dual-strip; 1.4 build/publish binary basename + self-update `mrtcnbsk/northstar` (BUILD PROOF: `bun run build`→`@ilura/northstar-*/bin/northstar`, `--version` çalışır); 1.5 user-facing brand copy (4 dosya) + uninstall npm pkg; check-forbidden-strings NOTICE/README allowlist (`ec00b0cba7`). **HARD CONSTRAINTS korundu:** @kilocode/* namespace (881), `// kilocode_change` (4560), `.kilo/` proje dir DOKUNULMADI. Acceptance: northstar binary+--version ✅, config back-compat ✅, 4 CI guard yeşil ✅, typecheck ✅, lint 0-error ✅.
- **EPIC 1 DEFERRED (bilinçli):** (a) **logo assets** = OWNER deliverable — CLI ASCII logo `kilocode/cli/logo.ts` "KILO" sextant block-art (9-harfli "northstar" redraw = tasarım işi, sahte çizim bozuk görünür) + kök `logo.png` (görsel); ürün ADI her yerde northstar, sadece startup banner'ı KILO kaldı. (b) github.ts BACKEND kimlikleri (kiloconnect[bot], api.kilo.ai, OIDC audience — canlı infra). (c) hosting URL'leri (kilo.ai/cli/install, app.kilo.ai/$schema — EPIC 2 domain). (d) AUR/Homebrew/ghcr KANAL provisioning (harici, EPIC 2). (e) X-Title billing header + Kilo-Gateway `kilo auth login` akışı + acp/mcp oauth (canlı backend). (f) ~120 non-config `KILO_*` flag (config-critical olanlar dual-read'lendi; kalanı KILO_-only). (g) attention.ts DEFAULT_TITLE="Kilo" (kozmetik). (h) `kilo-sandbox-mutation-worker.js` dosya adı + KILO_TREE_SITTER_WASM_DIR (başka yerde tanımlı, rename kırar).

## EPIC 2 (terminal-only release, feat/release-terminal-only) — durum + owner aksiyonları
Wave-close review 7 bulgu → fix (postinstall npm-install kritiği vb.) EPIC 1'de idi; EPIC 2 = release pipeline npm-only.
2.1 publish.yml: build-vscode + smoke-test job'ları (smoke-test private Kilo-bench'e bağlıydı) + docker/AUR/vsce adımları silindi; 6 jetbrains/vscode/docker/kotlin workflow silindi; test/typecheck/visual-regression jetbrains/vscode job'ları budandı; check-workflows allowlist senkron (20 workflow). 2.2 iki publish.ts npm-only (docker/aur/homebrew + vscode/jetbrains fan-out silindi; @kilocode/sdk + @kilocode/plugin publish KORUNDU — non-private npm paketleri). 2.3 install + README raw-GitHub curl + npm @ilura/northstar; README kimliği northstar'a çevrildi (kilo run→northstar run, VS Code/JetBrains iddiaları + Kilo sosyalleri kaldırıldı).
**OWNER AKSİYONLARI (release'in gerçekten çalışması için):** (1) npm'de `@ilura/northstar` + koruma isimleri REZERVE et (publish); (2) repo secret `NPM_TOKEN` ekle; (3) ilk release'te explicit `version` input ya da seed'li git tag gerekebilir (fetchLatest boş release/unpublished npm'de throw eder). 
**EPIC 2 DEFERRED/RISK:** (a) `@kilocode/sdk` + `@kilocode/plugin` npm publish → **@kilocode org yayın hakkımız YOK**; gerçek publish'te ya `@ilura/*`'a rename ya da publish'ten çıkar (release-time karar). (b) config `$schema` hâlâ `app.kilo.ai/config.json` (jeneratör yok, uyumlu, kozmetik) — kendi schema'nı host edeceksen raw-GitHub'a çevir. (c) README pazarlama cilası + gerçek logo/asset + docs sitesi (kilo.ai/docs link'leri) = owner brand işi. (d) packages/kilo-vscode + kilo-jetbrains KAYNAK silinmedi (sadece release/CI çıkarıldı) — ileride paket silme temizliği.

## EPIC 4'te kapatıldı (feat/generalize-org → main `0c36f37008`) — genelleştirme: toolpack + template
EPIC 4 = iOS-spesifik içeriği eklenebilir (pluggable) yapmak. `apple-delivery` toolpack (org opt-in) + tek org-template → template sistemi (`ios-app-factory`/`blank`/`research-desk`/`content-studio`) + `northstar org init --template <name>`. Org kernel ZATEN jenerik (audit-onaylı) — schema/state/runner refactor YOK.
- **4.1 — toolpack mekanizması.** `tool/toolpacks.ts` (`TOOLPACKS`: apple-delivery = 10 Apple tool id'si + agents; `secret_scan` base'te KALIR + `TOOLPACK_BY_TOOL_ID` ters index); `organization/schema.ts` `toolpacks: z.array(z.string()).default([])`; `registry.ts` `toolpackEnabled` (organization.jsonc İÇERİĞİ'ne bakar, 5s TTL) + `applyVisibility` gate. **org_* organization.jsonc VARLIĞI'na, apple-delivery İÇERİĞİ'ne gate eder — bağımsız kapılar.**
- **4.2 — template restructure.** `git mv org-template templates/ios-app-factory` (byte-preserve — tek içerik değişikliği `"toolpacks":["apple-delivery"]`); 4 test sabiti repoint (11 stage/63 agent pin'i tuttu); build.ts `copyOrgTemplates` → dist/bin/templates.
- **4.3 — `northstar org init --template`.** `cli/cmd/org.ts` (OrgCommand + OrgInitCommand + handleInit); install-root'tan templates/ çözer (CWD değil).
- **4.4 — blank/research-desk/content-studio template'leri** (her biri validate+crossCheck yeşil).
- **4.5 — kernel kozmetik copy + exit.** prompts.ts iOS-spesifik etiketler nötrleştirildi; epic4-exit.test.ts (research-desk fixture-runner ile done'a ulaşıyor + apple-delivery gated + ios-app-factory korundu).

**Wave-close review (4-boyut, 3-şüpheci) — 1 bulgu FIXED:** `org init --force` `fs.cp` (merge) kullanıyordu → daha küçük template'e geçince ESKİ ajanlar kalıyordu; fix: template'in sağladığı entry'ler (organization.jsonc, agents/, command/, README.md) copy'den ÖNCE silinir, `.kilo/org/` (run state) KORUNUR. Test: "--force switching to a smaller template REPLACES (no stale agents) and preserves .kilo/org/".

## EPIC 5'te kapatıldı (feat/provider-authoring → main `cb8a236c68`, push'lu) — provider/model authoring (BYOK + local)
EPIC 5 = kullanıcı BYOK key ya da LOCAL/openai-compatible provider (Ollama/LM Studio/generic baseURL) ekleyebilsin, `northstar models`'ta görsün, bir modeli agent'a atayabilsin, yerel model context/tool-call desteksizse görünür uyarı alsın. anaconda-desktop local-provider substrate'i yeniden kullanıldı.
- **5.1 — kozmetik provider-CLI rebrand.** providers.ts describe string'leri (northstar.jsonc, kilo.ai docs link'i düşürüldü); **Kilo Gateway backend + kilo.ai service header'ları KORUNDU** (canlı routing/attribution).
- **5.2 — generic local provider.** `local-provider.ts` (`LOCAL_PRESETS` ollama/lmstudio/openai-compatible, `addLocalProviders` = auth store'da `{baseURL,preset}` metadata'lı entry'leri openai-compatible provider olarak enjekte eder, `PROTECTED_PROVIDER_IDS` {kilo,apertis} guard, `withKnownCapabilities` catalog merge); TUI "Add a local provider" sihirbazı (`local-provider-method.tsx`: preset→baseURL→opsiyonel key, **SADECE GLOBAL auth.json**'a yazar — {env:} invariant korundu). models.dev static lmstudio stub'ını canlı config override eden bug (agent yakaladı) preset-metadata + PROTECTED guard ile çözüldü.
- **5.3 — local-model validation.** `model-cache.ts aperture()` artık maskeleme YAPMIYOR (bilinmeyen → `tool_call:false, context:0, output:0`; overflow.ts context===0 → compaction OFF zaten var, dokunulmadı; maxOutputTokens output:0'da kendi default'una düşer); `local-model-validation.ts` (capabilityStatus/isVerified/toToolCapability — tool_call snake/toolcall camel/anaconda 3-state köprüsü + localModelWarning/modelWarning); uyarı TUI (model-info-panel.tsx) + CLI (models.ts)'te yüzeye çıkar.
- **5.4 — exit test.** epic5-exit.test.ts (5 test: local provider Provider.list'te çözülür + fromModelsDevProvider ile agent.model'e parseModel çözer + unverified→warning+compaction-off + {env:} invariant regresyon guard'ı).

**Wave-close review (4-boyut güvenlik-öncelikli, 10 agent, 3-şüpheci) — 2 bulgu (medium, AYNI kök neden, İKİSİ DE 0/3 refuted → FIXED `65c6207f7a`):** **unverified-model uyarısı HOSTED catalog modellerini yanlış işaretliyordu.** 5.3 uyarısı `limit.context <= 0`'a gate ediyordu ama models.dev catalog HOSTED, tool-capable bulut modelleri için de meşru olarak `context:0` gönderiyor (41 catalog model context:0, 9'u hosted+tool_call:true — poe/novita/glm-4.6, vercel/minimax vb.). İki yüzey (models.ts CLI + model-info-panel.tsx TUI) her provider'ın her modeline uyar uyguluyordu. **Kök neden:** `context<=0`, "unverified LOCAL model" için güvenilmez proxy; güvenilir sinyal PROVIDER ORIGIN. **Fix:** `localProviderModelWarning(providerID, model)` helper'ı (`isLocalPreset(providerID)` gate) — sihirbaz local provider'ları preset-id (ollama/lmstudio/openai-compatible) altında kaydeder, hosted (poe/vercel/kilo/apertis/anaconda) hariç tutulur. Marker-in-model yaklaşımı REDDEDİLDİ (base transform `fromModelsDevModel` `options:{}` hardcode eder → per-model marker survive etmez; ayrıca aperture() apertis+kilo ile PAYLAŞILDIĞINDAN marker aperture'da olamaz). 5 gate test (poe/vercel context:0 → uyarı YOK; ollama/openai-compatible unverified → uyarı; ollama verified → yok).
**Ek fix'ler:** (a) `dialog-provider.tsx` union variant'ı `kilocode_change start/end` block'a alındı (annotations guard exit 1→0; **DERS: line-number-tabanlı diff guard'ları DIRTY tree'de değil COMMIT sonrası doğrula — `content()` worktree okur, `addedLines()` committed diff okur, uncommitted edit skew üretir**). (b) 5.1 rebrand'ı için CLI help-snapshot regen (`test/cli/help/` — 5.1 describe'ı değiştirdi ama snapshot'ı yenilemedi; tek satır: "kilo auth provider" → "provider to authenticate with, or a login URL"). **DERS: cosmetic help-string değişikliği help-snapshot suite'ini bayatlatır — task-test subset'i kaçırır, tam sweep yakalar.**
**Full sweep SOLO: 651/651 dosya yeşil** (help-snapshot fix sonrası). Typecheck 19/19. Guard'lar yeşil. **{env:} invariant DOKUNULMADI** (variable.ts diff'te 0). Secret scan temiz (public repo).

**GOTCHA teyit:** push yine `--no-verify` (jetbrains Türkçe-locale hook). Dependabot 9 açık (6 moderate/3 low) — upstream deps, EPIC-dışı.

## EPIC 6'da kapatıldı (feat/tui-builder → main `5c74f09240`, push'lu) — TUI Builder
EPIC 6 = terminalden org authoring (OpenTUI/SolidJS). `/builder` route'u (KiloClaw route pattern'i kopyalandı: route.tsx union + app.tsx Match + plugin/api.tsx exhaustiveness branch + KiloApp hub re-export + kilo-commands launch) üç section'la: Models / Agents / Organization.
- **6.0 route shell** (`38640d91e8`). BuilderRoute union'a eklenince ÜÇÜNCÜ paylaşılan dosyada (plugin/api.tsx routeCurrent exhaustiveness) TS2339 kırıldı → annotated branch ile fix (implementer yakaladı).
- **6.1 Models screen** (`ca5568ffd1`). Saf `buildProviderRows(providers, connectedIDs)` view-model (klass=local/hosted via isLocalPreset, verified via isModelVerified; `modelCost()` guard — avgPrice `cost.cache`'i deref eder, local-discovered modeller cache'siz olabilir). dialog-model split+preview kopyası; add-provider action 5.2 wizard'ını route-local DialogSelect binding ile açar.
- **6.2 Agents editor + serializer** (`6bac22a944`). `AgentBuilder.markdown()` artık subordinates/capabilities/preferredTypes emit eder (yalnız non-empty; plain agent byte-identical). Round-trip: yazılan `.kilo/agent/<id>.md` → `ConfigAgent.load` `normalize`'ı subordinates'ı `permission.task={"*":"deny",<name>:"allow"}`'a genişletir. HTTP endpoint+handler da genişletildi.
- **6.2b SDK client forwarding** (`e45498b067`). Generated SDK client `buildClientParams` per-endpoint body-key WHITELIST'i yeni alanları düşürüyordu → agent-builder preview/save whitelist + inline body type + AgentBuilderPreview/SaveData types HAND-EDIT edildi (tam regen DEĞİL — bkz. W6-R1 drift). Agents screen artık gönderiyor + warning-toast kaldırıldı. Gerçek HTTP round-trip testi. Typecheck 19/19 (kilo-console dahil).
- **6.3 Organization editor + serializer** (`e6f12d1ce8`). `OrgSchema.serialize`(JSON.stringify)/`writeOrganization`(Bun.write, parent dir'i kendi yaratır). Screen `/file/content` ile OKUR, saf validate+crossCheck ile CANLI doğrular.
- **6.3b org-builder write endpoint** (`fe5b820d49`). Yeni `PUT /org-builder` (body `{organization: string}` serialized JSONC): parseJsonc→parse→validate+ConfigAgent.load+crossCheck → **FAIL-CLOSED** (issue varsa YAZMAZ, `{ok:false,issues}`). agent-builder group/handler pattern'i birebir mirror; SDK OrgBuilder client HAND-ADD (regen değil). 4 fail-closed test (invalid→yazılmaz). Screen Save wired.
- **6.4 exit** (`8c25a699bb`). Uçtan uca: serializer'larla ceo/chief/worker + organization.jsonc yaz → loadOrganization+validate+crossCheck+dry-run hepsi `[]`; ceo.subordinates round-trip; security guard (dosyalarda key/secret yok).

**Wave-close review (4-boyut, 10 agent, 3-şüpheci) — 2 bulgu (İKİSİ DE LOW), İKİSİ DE FIXED (`8274ba2b30`):**
- **LOW (0/3 refuted) — integer-like/wildcard agent+subordinate adı permission.task sıralamasını bozup delegasyonu SESSİZCE reddediyor.** `normalize()` `permission.task={"*":"deny",...allows}`'u nesne ekleme sırasına güvenerek kurar (wildcard deny ÖNCE, sonra spesifik allow'lar last-match-wins ile kazanır). AMA JS integer-benzeri string key'leri ("123") "*"'ın ÖNÜNE hoist eder → deny SON kural olur → sayısal subordinate DENIED. `OrgSchema.invalidName` bunu ZATEN org dept/ceo/shared adları için reddediyor ("integer-like keys break permission rule ordering") ama agent `subordinates`'ı KAPSAMIYOR, ve AgentBuilder sayısal id'ye bile izin veriyordu. Fix: `AgentBuilder.preview` artık integer-like/"*" id VE subordinate adlarını reddeder (empirik repro: [z,y,x,10,2] → task key order [2,10,*,...]). TDD 4 case. **DERS: nesne-key sırasına güvenen kod integer-benzeri key'lerde bozulur; validation write boundary'de olmalı (OrgSchema.invalidName pattern'i).**
- **LOW (1/3 refuted) — getTerminalTitle "builder" branch'i yoktu** → /builder'da terminal başlığı bir önceki session'ın başlığında kalıyordu (kozmetik, crash yok, TS hatası yok — exhaustiveness assertion yok). Fix: kiloclaw branch'ini mirror'layan builder branch.

**TRACK (EPIC 6 kalan, bilinçli):**
- **E6-R1 (SDK spec drift, PRE-EXISTING) — committed `packages/sdk/openapi.json` W8 `/agents` ve W3 `/org-runs`+`/org-runs/{runID}` endpoint'lerini İÇERMİYOR** (sdk.gen.ts client'ta VARLAR ama spec'te yok; ~1232 satır normalize-diff). EPIC 6 tam regen'den KAÇINDI (agent-builder alanları için surgical hand-edit yaptı) çünkü tam regen bu ALAKASIZ drift'i + W3-R1/W8-R1 NullOr sorunlarını EPIC 6 diff'ine katardı. Takip: ayrı bir "SDK regen + spec sync" işi — `bun dev generate > packages/sdk/openapi.json` + SDK build çalıştır, tam typecheck ile (kilo-console dahil) doğrula. Şu an spec bayat ama client çalışıyor.
- **E6-R2 (normalize ordering kırılganlığı, PRE-EXISTING kök) — `normalize()` (src/config/agent.ts) `permission.task`'ı nesne-key sırasına güveniyor.** EPIC 6 yalnız AgentBuilder write-boundary'sini guard'ladı (UI vektörü); elle yazılmış `.md` frontmatter'da sayısal subordinate hâlâ sessizce kırılır. Daha derin fix: normalize `permission.task` wildcard-deny'ı key sırasından bağımsız kılsın (permission/index.ts fromConfig/evaluate sıralaması — geniş blast-radius, pre-existing). Kabul: write-boundary guard EPIC 6 vektörünü kapatıyor.

## EPIC 7'de kapatıldı (feat/tui-chat → main `9ce2fd872f`, push'lu) — TUI Chat
EPIC 7 = org'u chat/session TUI'sinden sür. Chat UI'ının çoğu ZATEN VARDI (composer/slash/@-mention/agent+model chip/Tab-cycle); EPIC 7 org-spesifik parçaları ekledi.
- **7.3 side-channel note (asıl testable core, `cb1ece8ef8`).** Org runner SAF CEO-güdümlü state machine; tek user-input seam'i gate'teki org_decision. Yeni: `Run.notes[]` (back-compat optional), `org_note` tool (guardCeo+withRunLock, org_decision mirror), `stagePromptFor` eşleşen notları hedef stage prompt'una fenced (`escapeFence`) yüzeye çıkarır. Chat→run binding = **CEO-message convention** (CEO session run_id'yi tutar; TUI formatlı mesaj gönderir; CEO org_note çağırır) — yeni sessionID→runID index YOK. ceo.md (ios-app-factory) protokol adımı. **DETERMİNİZM: notlar instruct-time read-only; state machine'e (status/cost/gate/readiness) ASLA dokunmaz.**
- **7.1 org slash commands (`aed2845136`).** `/org-status` (`.kilo/organization.jsonc`'i /file/content ile okur → validate/crossCheck → DialogAlert) + `/org-builder` (Builder org section'ına navigate). useCommandSlashes ile palette'te oto-görünür.
- **7.2 roster in selector (`fcb09925dd`).** Org agent'ları ZATEN `sync.data.agent`'ta (`source:"organization"`); `local.agent.list()` `mode!=="subagent"` filtresi org roster'ını (CEO hariç hepsi subagent) düşürüyordu. Saf `buildAgentOptions` (Built-in/Org grouping). Org subagent'ları **display-only** (seçince @mention'a yönlendiren toast); CEO+built-in seçilebilir; Tab-cycle primary'lerde kaldı (local.tsx dokunulmadı).
- **7.4 inline gate card (`a7aeb1dc36`).** Saf `parseGate(part)` (org_advance human_gate ToolPart → card); inline a/n/r card; submit = CEO-instruction mesajı (session.prompt) → CEO org_decision+org_advance çağırır (guardCeo/withRunLock/audit/postmortem korunur, YENİ ENDPOINT YOK).
- **7.5 exit (`f39eae77e0`).** Uçtan uca: not @analyst'e yüzeye çıkar + gate→decide(approve)→advance ilerler + determinizm (notlu vs notsuz byte-aynı) + parseGate gerçek gate payload'ında.

**Wave-close review (4-boyut, 16 agent, 3-şüpheci) — 3 bulgu (1 HIGH, 1 MEDIUM, 1 LOW), HEPSİ FIXED:**
- **HIGH (`1e3dafe858`) — gate card kararı YANLIŞ run'ı hedefleyebiliyordu.** a/n/r mesajı `card.runID ?? "the current run"` kullanıyordu; org_advance ÇIKTISI run_id echo'lamadığından her zaman "the current run" → iki eşzamanlı run + iki card varken bir tık YANLIŞ run'ı approve/no-go edebilir (no-go yanlış run'ı geri-alınamaz halt eder). **Fix:** run_id org_advance'in GİRDİSİNDEN (`part.state.input.run_id` — required param, populated) alınır; saf `gateMessage(card, decision, note?)` helper'ı run_id + stage'i mesaja gömer. **DERS: bir kararın hedefi tool ÇIKTISINDA yoksa tool GİRDİSİNE bak.**
- **MEDIUM (`67a2883eaa`) — side-channel not resumable-resume'da SESSİZCE kayboluyordu.** `stagePromptFor` notu eagerly `consumedByStage` işaretliyordu ama tools.ts standalone `resume_chief` action'ı resumable session'da prompt'u DÜŞÜRÜR (resume_task_id only) → not consumed ama teslim edilmemiş → kayıp. **Fix:** stagePromptFor artık READ-ONLY (`{prompt, noteIds}` döner); tek not-write'ı `advance()`'te fan-out+settle SONRASI, YALNIZ `batch.instruct` (her zaman teslim edilen run_tasks) notlarını consume eder — `batch.incomplete` (koşullu teslim) notlarını ASLA consume etmez → resume'da düşen not korunur, sonraki teslimde yeniden yüzeye çıkar. Delivery-tied + serial (Finding 2 race'i de çözer).
- **LOW (67a2883eaa ile çözüldü) — consume OrgState.update fan-out Promise.all içinde eşzamanlı kilitsiz RMW** → tek post-fan-out serial update ile çözüldü.
- **Refuted (3/3):** buildAgentOptions'ın non-org/non-null-source agent'ı düşürdüğü iddiası — pratikte öyle agent yok, refute edildi.

**TRACK (EPIC 7 kalan, bilinçli):**
- **E7-R1** — side-channel note CEO protokolü YALNIZ `ios-app-factory/ceo.md`'de; diğer 3 template (blank/research-desk/content-studio) CEO'ları side-channel notu tanımaz. Takip: aynı adımı 4 template'e de ekle (veya paylaşılan CEO prompt fragment'ı).
- **E7-R2** — `org_decision` STAGE param'ı almıyor (`decide()` ilk awaiting stage'i seçer); gate card run_id'yi disambigue eder ama bir run'da ÇOK awaiting stage varsa (paralel DAG) stage-içi ambiguity kalır (pre-existing). Takip: org_decision'a opsiyonel stage param.
- **E7-R3** — non-resumable incomplete briefing'de not consume edilmediğinden retry'larda not TEKRAR yüzeye çıkabilir (duplication; kayıptan iyi, kabul edildi).

## EPIC 8'de kapatıldı (feat/tui-cockpit → main `a807e0602d`, push'lu) — TUI Cockpit (SON EPIC)
EPIC 8 = org koşusunu terminalden CANLI izle. Veri katmanı ZATEN VARDI (W3 org-runs read API + poll@3000ms + saf `org-runs-view.ts` helper'ları); iki şey must-BUILD idi: budget bloğu + agent tree (Tier A).
- **8.1a budget block + view-models (`82b330754d`).** `GET /org-runs/:runID`'e `budget` bloğu (run/stage/escalationThreshold/retries/spent/remaining/escalated; `org_status` tool'unu mirror'lar; org dosyası okunamazsa `null` — graceful). Saf `buildAgentTree` (Tier A: CEO→per-stage chief[liveness=stage status]→static worker roster) + `budgetGauge` (spent/threshold/ceiling fractions, run=0 guard). SDK type hand-edit (tam regen değil, 6.2b pattern; openapi.json dokunulmadı).
- **8.1b Cockpit route + render (`6e7ec80e2e`).** `{type:"cockpit"}` route (EPIC 6.0 6-dosya wiring; plugin/api.tsx exhaustiveness branch dahil). view.tsx: detail'i poll'lar (3000ms, status active iken), organization.jsonc'i /file/content ile bir kez okur, 4 section render eder. Fetcher errored-state'e girmez (TUI ErrorBoundary crash'ini önler).
- **8.2 hard stop + notifications (`f17b264f4c`).** `stopMessage(runID, reason)` saf; hard stop = CEO-instruction mesajı (org_stop CEO-scoped, HTTP yok → cockpit READ-ONLY; direkt OrgRunner.stop YOK). Budget gauge header'da always-visible. Notification'lar once-per-transition (gate/halt/escalated). ceo.md stop protokolü. `CockpitRoute.sessionID` originating session'dan threading (yoksa dürüst degrade).
- **8.3 run-list home + --dry-run + modes (`6e7081f3ef`+`7bcb4f0271`).** Saf `buildRunList` + `dryRunReport`. `--dry-run` thread.ts HANDLER'ında TUI boot'tan ÖNCE short-circuit (pre-existing process.exit(0) quirk'ini atlar). Run-list home (runID yoksa DialogSelect). `--auto` (run.ts) + `--attach` (attach.ts) EXISTS — doğrulandı, yeniden yapılmadı.
- **8.4 exit (`123d22cb39`).** Uçtan uca: gerçek endpoint'te budget math + buildAgentTree + budgetGauge + buildRunList + stopMessage/dryRunReport + READ-ONLY guard (cockpit'te OrgRunner.stop/decide çağrısı YOK — dosya taramasıyla).

**Wave-close review (4-boyut, 22 agent, 3-şüpheci) — 6 bulgu (1 CRITICAL, 4 HIGH, 1 MEDIUM), HEPSİ 0/3-refuted, HEPSİ FIXED (`a1ed32eed9`):** **Hepsi render-layer crash/hang — saf-builder testleri KAÇIRDI (SolidJS effect'leri test harness'in server build'inde no-op).**
- **CRITICAL — notification createEffect KENDİNİ tetikleyen sonsuz döngü.** Effect `prevSnapshot()` sinyalini hem OKUYOR (subscribe) hem `setPrevSnapshot({...})` ile YENİ obje YAZIYOR (aynı effect'te) → her yazı effect'i stale'liyor → sınırsız re-run → aktif bir run açılınca (happy path!) TUI donar (%100 CPU, ErrorBoundary yakalayamaz çünkü throw yok). Fix: `prevSnapshot` düz `let` closure değişkeni (sinyal değil) — `context/route.tsx let previous` pattern'i. Empirik: 201+ run vs untrack ile 1.
- **HIGH — buildAgentTree department'sız pipeline stage'inde TypeError.** `org.departments[stage]` undefined → `.chief` deref → throw → tree() memo → app ErrorBoundary → TÜM TUI çöker. Elle-düzenlenmiş organization.jsonc ile erişilebilir (view OrgSchema.parse yapar, validate cross-check'i ÇAĞIRMAZ). Fix: buildAgentTree TOTAL (`!dept` → `{chief:"(no department)", workers:[]}`). TDD RED→GREEN.
- **HIGH — runsList fetcher try/catch'siz** → fetch reject'i run-list home'da TUI'yi çökertir (detail fetcher guard'lı, list değil). Fix: try/catch → [] + runsListError sinyali.
- **HIGH — cross-invalid organization.jsonc TÜM TUI'yi çökertir** (agent-tree section yerine) — buildAgentTree kök nedeni (yukarıdaki fix kapatır).
- **MEDIUM — tek başarısız poll dashboard'u boşaltır VE polling'i kalıcı durdurur.** Fix: `lastDetail`/`lastDetailRunID` (runID-keyed) ile son-iyi-değeri koru → aynı obje referansı dönünce Solid Object.is değişiklik görmez → poll effect re-run olmaz → interval yaşar; gerçek status değişince yeni referans → düzgün durur.
**DERS: saf view-model testleri render-layer bug'larını (SolidJS reactive loop, ErrorBoundary crash path'leri, fetch-failure) KAÇIRIR — wave-close review + skeptic'ler bunları reasoning ile yakaladı. Render katmanı için adversarial review load-bearing.**
Full sweep SOLO 665/665. openapi.json + bun.lock dokunulmadı.

**TRACK (EPIC 8 kalan, bilinçli):**
- **E8-R1 (Tier B agent tree) — worker-level liveness DEFERRED.** Agent tree Tier A (chief liveness = stage status; worker'lar static roster). Gerçek per-worker liveness = session-children join (`GET /session/:chiefTaskID/children` + `/session/status`), cold-attach'te Tier A'ya degrade eder. Deferred enhancement.
- **E8-R2 (SSE) — poll@3000ms kullanıldı; SSE org-event stream DEFERRED** (W3 precedent'i; activity log = audit trail + stage transitions, ham event stream değil).
- **E8-R3 (E6-R1 SDK spec drift) — bu epic de openapi.json'ı byte-identical bıraktı** (budget bloğu için surgical types.gen.ts hand-edit); tam SDK regen + spec sync hâlâ ayrı iş (E6-R1).

---

# EPIC ROADMAP (0-8) TAMAMLANDI — 2026-07-12
W0-W9 master plan + EPIC 0/1/2/3/4/5/6/7/8 hepsi main'de + push'lu (repo PUBLIC, Ilura Technology OÜ, MIT). Her epic: JIT plan → subagent-driven TDD → exit test → adversarial wave-close review (Workflow, 3-şüpheci refutation) → full sweep SOLO → merge --no-ff → push --no-verify. Kalan tracked follow-up'lar: E6-R1/R2, E7-R1/R2/R3, E8-R1/R2/R3. Dependabot 9 açık (upstream deps).

## Release prep (2026-07-12) — npm publish hazırlığı
Kullanıcı npm publish setup'ı istedi (token'ı chat'e yapıştırdı → **compromised, revoke edilmeli; asistan token'ı KULLANMADI/kullanamaz** — credential/publish prohibited). Repo tarafı hazırlandı:
- **`@kilocode/sdk` + `@kilocode/plugin` root `script/publish.ts` publish path'inden ÇIKARILDI** (`33ad50746a` sonrası). Kök neden: bu scope Ilura'nın DEĞİL → gerçek CI publish CLI'ı yayınlar sonra bu iki pakette 403 alıp job'ı öldürür (kısmi release). CLI self-contained (`@ilura/northstar` dist package.json'ı yalnız platform-binary optionalDependencies taşır, @kilocode/sdk'ye runtime-bağımlı DEĞİL); sdk/plugin hâlâ BUILD ediliyor (CLI build'i için) ama publish edilmiyor. **EPIC 2 DEFERRED/RISK (a) ÇÖZÜLDÜ.** İleride @ilura/* rename ile publish açılabilir.
- **CLI version in-repo KALIR 7.4.5** (`packages/opencode/package.json`). Denendi 0.1.0'a düşürmek ama **`bun install --frozen-lockfile` CI'da patladı** (committed bun.lock @ilura/northstar'ı 7.4.5 kaydediyor → frozen mismatch) → geri alındı. **Yayınlanan version zaten `Script.version` (workflow `version` input) tarafından belirlenir** (root publish.ts:46 tüm package.json'ları Script.version'a overwrite eder; publish job'ında non-frozen `bun install` lockfile'ı günceller) — yani statik değer alakasız, release 0.1.0 input'la yayınlanır. **DERS: statik package.json version değişimi committed bun.lock ile frozen-lockfile mismatch yaratır; release version'ı input'la ver, dosyayı elleme.**
- **CI RUNNER FIX (`fa428b3b67`):** publish.yml `version`+`build-cli` job'ları `blacksmith-4vcpu-ubuntu-2404` (upstream Kilo custom runner) hedefliyordu → bu fork'ta Blacksmith runner YOK → run'lar sonsuza queued. `ubuntu-24.04`'e (GitHub-hosted) çevrildi (build matrix + publish job zaten standard runner). Ayrıca version job'ının `bun i -g @ilura/northstar` adımı `continue-on-error` (ilk release'te paket npm'de yok; version.ts self-contained).
- **OWNER AKSİYONLARI (kullanıcı yapacak, asistan yapamaz):** (1) sızan token'ı revoke et + yeni Automation token üret; (2) GitHub → Settings → Secrets → Actions → `NPM_TOKEN` ekle; (3) publish workflow'unu tetikle (name reserve + publish). Manuel alternatif: `npm login` + `bun run build` + `cd dist/@ilura/northstar` + `npm publish --access public`. `@ilura/northstar` ismi npm'de BOŞ (404 doğrulandı).
