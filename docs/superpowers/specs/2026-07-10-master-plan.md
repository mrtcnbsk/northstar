# Northstar Master Plan — Otonom Apple Yazılım Şirketi

**Tarih:** 2026-07-10
**Girdiler:** Kullanıcının 30 bölümlük eksik listesi (2026-07-10 mesajı) · [Master-plan dossier](2026-07-10-master-plan-dossier.md) (10 küme raporunun sentezi, codebase-doğrulanmış) · [tracked-followups](../tracked-followups.md) · v1 org çekirdeği ([spec](2026-07-09-agent-organization-core-design.md))
**Durum:** Sahip onayı bekliyor (aşağıdaki açık kararlarla birlikte)

## 1. Hedef ve SNR %85 Yorumu

Nihai hedef: Northstar'ı fikirden App Store'a **denetimli-otonom** çalışan bir yazılım
organizasyonuna dönüştürmek. "SNR %85" şöyle işletilir:

1. **Kapsam filtresi:** Yalnızca dossier'de EXISTS/PARTIAL/MISSING sınıfında olup net
   kaldıraç taşıyan maddeler plana girer. Dossier §4'teki **Rejected** listesi (matrix org,
   ensemble execution, hallucination scoring, WWDC indexing, plugin marketplace vb.)
   inşa EDİLMEZ; **Deferred (EXTERNAL)** listesi hesap/servis kararı çözülünce açılır.
2. **Dalga disiplini:** Her dalga gerçek bir org koşusu üzerinde kanıtlanabilir bir
   **exit testi** ile biter — çalışmayan/gösterilemeyen iş "sinyal" sayılmaz.
3. **Ölçüm:** Dalga kapanışında commit edilen işin ≥%85'i (a) yeşil testlerle kapsanmış
   ve (b) exit testinin geçtiği yolda kullanılıyor olmalı; süs/spekülasyon reddedilir.

## 2. Dalga Sırası (dossier §3'ün onaylanmış hali)

Sıra ve içerik dossier'deki gibi; burada yalnız karar noktaları ve teslim tanımı:

| Dalga | İçerik (özet) | Süre | Kapattığı §'ler | Kapı |
|---|---|---|---|---|
| **W0 Sertleştirme + config kazanımları** | tracked-followups'taki 5 gerçek bug; audit export (`approvals.json` + `audit_log` tool); acil durdurma; prompt-injection sanitizer; **+32 Apple uzman/validator agent'ı** | ~1h | güvenilirlik, §26, §9/§22/§27 dilimi, §4(stop) | — |
| **W1 Bütçe motoru** | aşama/koşu tavanları + halt; ön-uçuş maliyet tahmini; approval matrix + eskalasyon kuralları; maliyet-farkındalıklı fallback zinciri | ~1-1.5h | §4, §23 çekirdek, §3 kısmi | Karar #8 (varsayılanlarla başlanabilir) |
| **W2 Build & test runtime** | xcodebuild/swift orkestrasyon tool'u; simulator yönetimi; SwiftLint/Format entegrasyonu; snapshot test; crash symbolication zinciri; log toplama | ~1-1.5h | §10 yerel çekirdek, §11, §13/§14 kısmi | — |
| **W3 Gözlemlenebilirlik** | org state→DB sync; kilo-console org rotası (maliyet/timeline/durum); bildirimler (kapı/bütçe/aşama) | ~1-1.5h | §24, §22 bildirim, §1-2 metrik zemini | — |
| **W4 Workflow DAG** | `stage.requires[]` + döngü doğrulama; paralel zamanlayıcı; retry/timeout; koşullu dallar | ~1.5-2h | §5, §1(load bal.) | — |
| **W5 Kalite kapısı** | pipeline'a `review` aşaması; çok-reviewer konsensüsü (W4 paralelliğiyle); compliance validator tool'ları (PrivacyInfo/ATS/guideline) | ~1.5h | §12, §15, §16 a11y, §26 validators | Karar #9 |
| **W6 Bellek & öğrenme temeli** | postrun postmortem kancası; org-kapsamlı paylaşımlı bellek; org-RAG (namespace + citation) | ~1.5h | §6, §25 çekirdek, §8, §9(arama) | Karar #4 (varsayılan: LanceDB yerel) |
| **W7 Apple teslimat hattı** | arşiv/IPA; ASC istemcisi; TestFlight; metadata; submission; review-monitoring | ~2-3h | §20, §10 kalanı | **Karar #1/#2 ŞART** |
| **W8 Registry & routing v2** | yetenek etiketleme; agent sağlık/performans skoru (W3 verisiyle); benchmark harness; artifact graph + rollback | ~2h | §2, §1(health), §29 kısmi, §9 kalanı | — |

(Süreler tek-operatör takvim haftası tahminidir; "h"=hafta. Horizon/v2 backlog dossier §3 sonunda.)

## 3. Yürütme Protokolü (her dalga için aynı)

1. **JIT detay planı:** Dalga başlarken writing-plans disipliniyle bite-sized TDD görev
   planı yazılır (`docs/superpowers/plans/2026-XX-XX-wave-N.md`) — master plan dalga
   İÇERİĞİNİ, JIT planı dalga ADIMLARINI netleştirir. Böylece geç dalgalar bayat plana
   değil güncel codebase'e göre planlanır (v1'de plan-drift'in Critical'e yol açtığı ders).
2. **Subagent-driven TDD:** Görev başına taze implementer + spec-uyum reviewer +
   kod-kalite reviewer; Important bulgular aynı implementer'da düzeltilir, yeniden
   review edilir (v1 kadansı aynen).
3. **Dalga exit testi:** Dossier'deki exit testi gerçek bir org koşusunda koşulur ve
   çıktısı dalga kapanış commit'ine not düşülür.
4. **Dalga final review'u:** Bütün-dalga diff'i üzerinde final reviewer; MERGE:READY
   olmadan sonraki dalga başlamaz.
5. **Branch stratejisi:** Her dalga `feat/wave-N-<ad>` branch'inde; exit + final review
   sonrası main'e merge. (v1 branch'inin merge kararı açık soruda.)
6. **Kapsam değişikliği:** Dalgaya dossier haritası dışından madde eklemek sahip onayı
   gerektirir (SNR koruması).

## 4. Açık Kararlar

Dossier §5'teki 10 karar. Şimdi bloklayanlar: **#8** (W1 bütçe varsayılanları — önerilen:
koşu tavanı $50, aşama tavanı $15, eskalasyon eşiği $10, retry 2; config'te değiştirilebilir)
ve **#9** (W5 pipeline reorder). **#1/#2** (Apple hesabı + fastlane-vs-ASC) W7'den önce;
**#4** LanceDB-yerel varsayılanıyla ilerlenir; #3/#5/#6/#7/#10 ilgili dalgadan önce sorulur.

## 5. Riskler

- **Upstream merge yükü:** Dalgalar ilerledikçe kilocode-dışı dokunuşlar artacak (W4 runner
  genellemesi en büyüğü) — marker disiplini + dalga-başı upstream rebase kontrolü.
- **Ortam:** Kullanıcının diski tekrar tekrar doluyor; tam sweep'ler izole runner'la ve
  alan kontrolüyle koşulmalı (bkz. tracked-followups ortam notları).
- **EXTERNAL kapılar:** W7 Apple hesabı olmadan başlatılamaz; plan W7'yi atlayıp W8'e
  geçebilecek şekilde sıralandı (W8'in W7'ye bağımlılığı yok).
