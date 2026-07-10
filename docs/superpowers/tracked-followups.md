# Tracked Follow-ups — feat/agent-organization final review ledger

Kaynak: bütün-branch final review (MERGE: READY-WITH-TRACKED-FOLLOWUPS, 2026-07-10).
Bu maddeler bilinçli olarak ertelendi; master planda ilgili bölümlerle birlikte ele alınmalı.

## TRACK (takip — düzeltilecek)

1. `src/tool/task.ts`: derinlik guard'ı `ctx.ask`'ten SONRA çalışıyor (kullanıcı onayladıktan
   sonra derinlik reddi görebilir); ayrıca `ctx.sessionID` için fazladan bir `sessions.get`.
2. `deriveSubagentSessionPermission` (herhangi task kuralı) vs `KiloTask.nestedTask`
   (non-deny + non-wildcard) yüklem uyumsuzluğu — delik yok, ama savunma katmanları
   tek yüklemde birleştirilmeli.
3. `OrgDepth` düz `Error` ile fail ediyor (NamedError idiyomu değil); mesaj org-dışı derin
   zincirlerde de "Workers cannot spawn subagents" diyor.
4. Global config'te SPESİFİK desenli bir task kuralı hâlâ tüm subagent'ları "yönetici"
   yapar (derinlik tavanı + ask değerlendirmesi sınırlar). Config dokümantasyon uyarısı
   veya kaynak-kapsamlı kural kontrolü.
5. `experimental.primary_tools` dedup yerleşimi session-level task deny'ı findLast'ta
   yenebilir (pre-existing; child tools map yine de kapatıyor).
6. `schema.ts`: `validate()` hatası `at ${file}` içermiyor; jsonc çift hata satırları
   dedupe edilmiyor; `crossCheck`'te ceo lookup'ı `Object.hasOwn` değil.
7. Runner: A→B→A session değişiminde maliyet çift sayılabilir (per-session cost map
   çözer); `assertPipelineMatches` tek yönlü (org'dan çıkarılan stage sessizce yok sayılır);
   `status()` pipeline-mismatch assert'ini atlar.
8. Org tool'ları TÜM primary agent'lara görünür — `applyVisibility` tarzı
   organization.jsonc-varlık kontrolüyle gizlenmeli (memory tools emsali, registry.ts).
9. `incomplete` + resume-edilemez task_id fallback'inde CEO'nun step-5 prompt'u zayıf
   (idea/prior context yok) — org_advance task_id'yi atlarken tam stage prompt'u da dönmeli.
10. Şef edit izni `runs/*/state.json`'ı da kapsıyor — `.kilo/org/runs/*/deliverables/**`
    daha sıkı olur (şef pipeline state'ini kurcalayamaz).

## ACCEPT (tasarım gereği / pre-existing)

- webfetch/websearch skaler izinler (URL-desen yok) — şablonlar prompt-seviyesi kısıt kullanır.
- Prompt fence'leri whitespace varyantlarını (`</idea >`) yakalamaz — heuristik savunma.
- `updateGlobal` normalize-materyalizasyonu (pre-existing normalize-on-decode özelliği).
- Plan dokümanı drift'leri (Task 11 tek-arg tryPromise; URL-keyed webfetch örnekleri) —
  plan point-in-time artifact; `**/.kilo/org/**` drift'i Critical'e yol açtı ve düzeltildi.

## Ortam notları

- Kullanıcının diski tekrar tekrar %100'e doluyor (opencode-test-* temp klasörleri iki kez
  ~9GB temizlendi). Merge-öncesi tam sweep CI'da veya alanı olan makinede koşulmalı.
- `bun.lock` yerel drift'i (kilo-jetbrains 7.4.4→7.4.5) commit'lere alınmıyor.
- Tam test sweep'i `bun test` ile değil `bun run script/test-runner.ts` ile (izole runner).
