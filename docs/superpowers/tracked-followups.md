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
