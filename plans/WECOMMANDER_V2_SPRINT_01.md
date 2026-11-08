# WECOMMANDER V2 — Sprint 01

- **Sürüm:** v0.2 · **Hazırlanma:** 2026-11-07
- **Senaryo:** S2 (iki geliştirici). **D1** = Agent Mode + Rust çekirdek + sürüm sorumlusu; **D2** = masaüstü/arayüz.
- **Kaynak:** [Master Plan](./WECOMMANDER_V2_MASTER_PLAN.md), [Takvim](./WECOMMANDER_V2_DEVELOPMENT_CALENDAR.md). Aşağıdaki tarih tablosu [`wecommander_v2_scheduler.py`](./tools/wecommander_v2_scheduler.py) ile üretilir.
- **Durum:** Hazır. Bu belge ürün kodu içermez; kod geliştirme ancak PR #97 kabul edildikten sonra başlar.

## 1. Sprint penceresi ve takvimdeki yeri

<!-- GENERATED:BEGIN sprint -->
| Kalem | Kulvar | Plan başlangıcı | Plan bitişi | Sprint 01 içindeki durum |
|---|---|---|---|---|
| B01 | D1 | 2026-11-09 | 2026-11-20 | sprint içinde biter |
| A01 | D2 | 2026-11-16 | 2026-12-18 | sprint sonunda devam eder (bitiş W6) |
| B03 | D1 | 2026-11-23 | 2026-12-25 | sprint sonunda devam eder (bitiş W7) |

Sprint 01 penceresi: 2026-11-09 – 2026-12-04 (4 hafta, S2).
<!-- GENERATED:END sprint -->

## 2. Sprint hedefi

1. **B01 tamamlanır ve production'a çıkar:** AI `terminal_input` boşluğu kapanır; kontrol ajan tarafında zorunlu.
2. **B03 başlar:** Durum makinesi tasarım notu onaylanır; gateway `operations` tablosu ve ajan işlem günlüğünün ilk dilimi PR olarak hazırlanır.
3. **A01 başlar ve G1'in ilk iki kontrolü sonuçlanır:** Tauri güncelleme turu ve işletim sistemi anahtar deposu duman testi.

## 3. Paralel başlangıç ve sıra

| Kulvar | Hafta 1 (9 Kasım) | Hafta 2 | Hafta 3 | Hafta 4 |
|---|---|---|---|---|
| D1 | B01 uygulama + testler | B01 kabul, promote (sahip onayı) | B03 tasarım notu → onay; `operations` tablosu | B03 ajan işlem günlüğü (nonce kaydı) |
| D2 | İşe alışma: depo, CI, yerel geliştirme ortamı; A01 için Tauri 2 iskelet denemesi | A01 iskelet (`desktop/`, çalışma alanı yapısı, CI derleme işi) | A01: G1 güncelleme turu (3 işletim sistemi) | A01: G1 anahtar deposu duman testi, iki çalışma alanı arasında geçiş |

**Neden bu sıra?**
- B01 güvenlik önceliği nedeniyle ilk iştir.
- B03, B01'in onay bağlamasını kullanır; sırayla yapılırlar.
- A01, A02 ve A03 birbirinden bağımsızdır. Hangisinin önce yapıldığı U1 ve V2 Stable tarihlerini değiştirmez (araçla karşılaştırıldı). A01 önce seçildi; çünkü G1'i (paketleme ve anahtar deposu) erken sonuçlandırıyor ve D1'in A05 işine erken başlamasını sağlıyor.
- A02 Sprint 02'de, A03 Sprint 03'te başlar. S4 senaryosunda A01, A02 ve A03 ilk hafta paralel başlardı.

## 4. Paketler

### B01 — AI `terminal_input` yetkilendirme düzeltmesi (D1)
- **Ön koşul:** Yok. **Bağımlı:** B03, B02, B04, A24.
- **Beklenen PR'lar:**
  1. `fix(security): require approval for AI terminal input` — `protocol.ts`, `mcp.ts`, `security.ts`, `crates/agent/src/{protocol,ops,approval,terminal}.rs`, `dc-compat.ts`, testler.
  2. Sözleşme matrisi ve araç açıklaması güncellemesi (aynı PR veya ayrı doküman PR'ı).
- **Testler:** Master Plan B01'deki 8 test, `mcp-client-acceptance.mjs`, Rust birim testi (gateway'i atlayan istek).
- **Kabul:** CI yeşil; Windows ve Ubuntu'da Claude ile gerçek kabul; `promote-production.yml` ile production (sahip onayı).
- **Riskler:** Desktop Commander uyumlu istemcilerde etkileşimli kullanımın yavaşlaması. Bu kabul edilen bir bedel; `full` güven ve süreli "AI yazabilir" izni seçenekleri var.

### B03 — Onaylı işlem durum makinesi (D1, Sprint 02'de biter)
- **Ön koşul:** B01. **Bağımlı:** B02, B12.
- **Sprint 01 içindeki PR'lar:**
  1. `docs: operation state machine` — `docs/OPERATION_STATE_MACHINE.md`: durumlar, geçişler, 8 senaryonun beklenen davranışı.
  2. `feat(gateway): persistent operations table` — migration + gateway durum geçişleri (henüz davranış değişikliği yok, özellik bayrağının arkasında).
  3. `feat(agent): operation journal with nonce replay protection` (sprint sonunda taslak).
- **Sprint 01 kabulü:** Tasarım notu sahip tarafından onaylandı; migration `migration-idempotence.mjs` testinden geçti; ajan günlüğü birim testleri yeşil.
- **Riskler:**
  - Hata enjeksiyon testlerinin (ağ kesintisi, süreç sonlandırma) CI'da kararsız (flaky) çalışması. Azaltma: deterministik sahte relay ve ajan yeniden başlatma yardımcıları.
  - Günlük biçimi tasarımı. Azaltma: `terminal_history.rs` biçim deneyimi yeniden kullanılır.

### A01 — Desktop iskeleti ve G1 (D2, Sprint 02'de biter)
- **Ön koşul:** Yok. **Bağımlı:** A04, A05, A08, A09, B09.
- **Sprint 01 içindeki PR'lar:**
  1. `feat(desktop): Tauri 2 app skeleton with User and Agent workspaces` — `desktop/`, kök `Cargo.toml` çalışma alanı, `crates/wc-ssh-core` ve `crates/wc-vault` boş crate'leri, `packages/terminal-ui` iskeleti.
  2. `ci: desktop build on windows, macos, ubuntu` — yeni CI işi (mevcut işlere dokunmadan), `cargo-deny`.
  3. `docs: G1 report` — güncelleme turu ve anahtar deposu sonuçları, gerçekleşen efor.
- **Kabul (Sprint 01 sonu):** Üç işletim sisteminde CI derlemesi yeşil; G1 güncelleme turu en az iki işletim sisteminde başarılı; anahtar deposu duman testi raporlandı.
- **Riskler:**
  - macOS imzasız uygulamada güncelleme davranışı. Bu, Apple hesabı kararına bağlıdır.
  - Secret Service olmayan Linux ortamları. Ana parola yoluyla çözülür.

## 5. Sprint 01 kabul kriterleri

1. B01 production'da; kabul notu yazılmış.
2. B03 tasarım notu onaylanmış; gateway migration ve ajan günlüğü PR'ları açık, CI yeşil.
3. A01 iskeleti ve CI işi merge edilmiş; G1 raporu açık PR'da.
4. Mevcut CI işlerinin hiçbiri kırılmamış; `release-gate` gerekli işleri değişmemiş.
5. `plans/data/wecommander_v2_actuals.json` dosyasına B01'in gerçekleşen eforu işlenmiş.
6. Sprint sonu notu: planlanan ve gerçekleşen, açık riskler, Sprint 02 kapsamı.

## 6. Sprint 02 ön görünümü

- **D1:** B03 tamamlanır (8 senaryo testi), ardından B02 (v1.0 kapanışı).
- **D2:** A01 tamamlanır (G1 raporu), ardından A02 başlar (G2: russh matrisi ve `russh-sftp` denemesi).

## 7. Doğrulama kapıları (bu sprintte başlayanlar dahil)

<!-- GENERATED:BEGIN gates -->
| Kapı | Ne zaman | Ad | Kontroller | Başarısızlıkta |
|---|---|---|---|---|
| G1 | A01 bitince (S2: 2026-12-18) | Tauri paketleme/güncelleme ve anahtar deposu doğrulaması | Windows, macOS ve Linux'ta imzalı güncelleme manifestiyle N → N+1 güncelleme turu<br>Windows DPAPI/Credential Manager, macOS Keychain, Linux Secret Service ile keyring duman testi; Secret Service olmayan Linux'ta ana parola yolunun çalışması<br>Kurulum boyutu ve ilk açılış süresi ölçümü | A04 ve A05 tahminleri yeniden hesaplanır; gerekirse Linux için ana parola zorunlu varsayılan olur |
| G2 | A02 bitince (S2: 2027-02-05) | russh uyumluluk matrisi ve SFTP olgunluğu | Ubuntu OpenSSH 9.x, eski OpenSSH 7.x, Windows OpenSSH Server, macOS sshd ile parola, anahtar, keyboard-interactive ve harici ajan<br>Algoritma matrisi (kex, host key, şifre, MAC) ve Terrapin önlemleri<br>russh-sftp ile 1 GB yükleme/indirme, devam, 10.000 dosyalı dizin listeleme (2 günlük teknik deneme)<br>FIDO2 (sk-*) desteğinin russh'ta var olup olmadığının belirlenmesi | russh-sftp yetersizse A09'a +2 MH (SFTP v3 katmanı); FIDO2 yerleşik değilse A17 OpenSSH uyumluluk motoruyla başlar (tahmin değişmez) |
| G3 | A03 bitince (S2: 2027-03-12) | xterm.js WebView performansı | WebView2, WKWebView ve WebKitGTK'de 10 MB çıktı akışında arayüzün donmaması<br>WebGL çizicinin kullanılamadığı yerde canvas/DOM'a düşme<br>vim, htop, Türkçe IME, kopyala/yapıştır | Linux için ek optimizasyon işi A08'e +1 MH; Linux U1 kapsamında 'beta' etiketiyle kalabilir |
| R1 | M1 bitince (S2: 2027-03-12) | Zorunlu takvim revizyonu | A01–A03 gerçekleşen eforları actuals dosyasına işlenir<br>Hız katsayısı hesaplanır ve kalan paketlere uygulanır<br>G1–G3 sonuçlarına göre yeniden tahminler girilir<br>Takvim aynı araçla yeniden üretilir ve belgeler güncellenir (ayrı PR) | Hız katsayısı 1,3'ün üstündeyse sahip kapsam veya kaynak kararı verir |
<!-- GENERATED:END gates -->

## 8. Geliştirmeye başlamak için kalan gerçek engeller

| Engel | Sahibi | Etki | Çözüm |
|---|---|---|---|
| İkinci geliştiricinin (D2) kim olacağı belli değil | Sahip | S2 takvimi ancak D2 9 Kasım haftasında başlarsa geçerli | D2 başlayana kadar takvim S1 gibi işler; araç başlangıç gecikmesiyle yeniden hesaplanabilir (`onboarding_weeks`) |
| PR #97'nin kabulü | Sahip | Plan resmîleşmeden ürün kodu başlamaz | İnceleme ve Draft'tan çıkarma |
| B01 için production onayı | Sahip | B01 production'a çıkamaz | `promote-production.yml` onayı |
| Apple Developer hesabı kararı | Sahip | G1'in macOS güncelleme kontrolü, U1'in macOS dağıtımı | U1'den önce, mümkünse Sprint 02'de karar |
| Açık PR'lar #29 ve #25 | Sahip | B02 içinde karara bağlanacak | Merge veya kapatma kararı |
| Gerçek cihaz erişimi (Windows, Mac, Ubuntu) | Sahip | B01 kabulü ve G1 | Mevcut cihazlar yeterli |
