# Tracked Follow-ups — agent-organization ledger

Kaynak: feat/agent-organization final review (2026-07-10) + Wave 0 kapanış review'u
(feat/wave-0-hardening, WAVE-MERGE: READY-WITH-TRACKED-FOLLOWUPS, 2026-07-10).

## MUST-FIX (Wave 1'in İLK işi — gerçek run iddiasından önce)

- **W0-R1 — Org yazma yolu gerçek run'larda ÖLÜ (v1'den beri gizli Critical).**
  `ceo.md`'nin `edit/bash: deny`'ı ve şeflerin `edit "*": deny`'ı, session türetimiyle
  (`subagent-permissions.ts:28` parentAgentDenies + `kilocode/tool/task.ts` `inherited()`)
  her alt session'a `"*" deny` olarak taşınıyor; değerlendirme findLast (session kuralları
  sonda) olduğundan şefin deliverables allow'unu ve worker'ın edit/bash allow'unu YENİYOR.
  Kanıt (gerçek template + gerçek evaluator): şef deliverable yazamıyor, worker app kodu
  yazamıyor, worker `swift build` çalıştıramıyor → her gerçek run 1. stage'de
  "deliverable missing" ile ölür. W0.4c seam testi yalnız AGENT ruleset'ini ölçtüğü için
  yeşil. Fix, birleşik-seam testiyle şunları pinlemeli: şef deliverable=allow,
  şef state.json=deny, worker app-kodu=allow, worker `.kilo/org/**`=deny.
  (Eski #10 ve aşağıdaki W0-R3 bu maddenin kabul kriterlerine katlandı.)
- **W0-R3 (W0-R1'e bağlı) — worker şablonlarına açık `.kilo/org/**` edit deny.**
  Bugün tartışmasız (kimse yazamıyor); W0-R1 düzeltilir düzeltilmez worker'ların blanket
  edit allow'u state.json'a delege yazmayı mümkün kılar (W0.4 review notu). W0-R1
  fix'iyle AYNI commit'te kapatılmalı.

## TRACK (takip — düzeltilecek)

- **W0-R2 — org tool'ları için per-run serialization (Wave 1 başı).**
  `OrgState.update` + `OrgAudit.append` kilitsiz read-modify-write; AI SDK paralel tool
  call'ları eşzamanlı çalıştırır ve ikinci bir opencode instance'ı aynı projede koşabilir.
  Somut tehlike: stale bir in-flight `org_advance`, `org_stop`'un persist ettiği
  `halted`'ı tüm-dosya yazımıyla `active`'e geri döndürebilir (acil durdurmayı sessizce
  bozar). Fix: tools.ts'te runID başına mutex/semaphore (~20 satır) + tek-yazar
  varsayımı yorumlarının güncellenmesi.
- **#3 (kalan yarı):** `OrgDepth` hâlâ düz `Error` ile fail ediyor (NamedError idiyomu
  değil). Mesaj Wave 0'da nötrleştirildi (kapatıldı).
- **#4:** Global config'te SPESİFİK desenli bir task kuralı hâlâ tüm subagent'ları
  "yönetici" yapar (derinlik tavanı artık ask'ten ÖNCE çalışıyor — blast radius küçüldü).
  Config dokümantasyon uyarısı veya kaynak-kapsamlı kural kontrolü.
- **#5:** `experimental.primary_tools` dedup yerleşimi session-level task deny'ı
  findLast'ta yenebilir (pre-existing; child tools map yine de kapatıyor).
- **#6:** `schema.ts`: `validate()` hatası `at ${file}` içermiyor; jsonc çift hata
  satırları dedupe edilmiyor; `crossCheck`'te ceo lookup'ı `Object.hasOwn` değil.
- **Minor (W0 kapanış):** `OrgRunner.decide`'da audit append state güncellemesinden
  sonra; append hatası (disk dolu) kararı persist edip tool'u fail ettirir, retry
  "no stage awaiting approval" der. Warning-note'a düşürülmeli. Ayrıca
  `OrgAudit.Entry.decision` serbest string (enum + "stop" olabilir).

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

## Ortam notları

- Kullanıcının diski tekrar tekrar %100'e doluyor (opencode-test-* iki kez ~9GB
  temizlendi; Wave 0 kapanışında 5 klasör daha silindi). Tam sweep CI'da veya alanı
  olan makinede.
- `bun.lock` yerel drift'i (kilo-jetbrains 7.4.4→7.4.5) commit'lere alınmıyor
  (Wave 0 commit'lerinde de yok — doğrulandı).
- Tam test sweep'i `bun test` ile değil `bun run script/test-runner.ts` ile (izole runner).
