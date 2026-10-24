## 24 Ekim 2026 — A/B/C/D: native dosya okuma symlink yarışını sertleştirme

- **A / PASSED (giriş kodu):** [CI #40110624425](https://github.com/orhanbal/webrising-commender/actions/runs/40110624425) / `54c4ee7c` 17/17 PASSED; önceki kırmızı `integration` SMTP outbox yarışı giderilmişti. Bu kanıt yeni kod commitlerine taşınmaz.
- **B / KODLANDI, PENDING:** [`c8cb2438`](https://github.com/orhanbal/webrising-commender/commit/c8cb2438848db12766cf18c71108991e1f9f8602) Rust Agent'da `text_search`, `fs_read`, `fs_read_lines` ve `fs_replace` için normal dosya handle'ı ve son bileşen symlink izlememe koruması ekler (Linux `O_NOFOLLOW`, macOS `O_NOFOLLOW`, Windows reparse-point açma bayrağı). `fs_replace` içeriği artık 4 MiB + 1 bayt fiziksel sınırla okur; metadata/read büyüme yarışında bellek sınırsız büyümez. Ücretli veya yeni runtime bağımlılığı yok.
- **C / TESTLER KODLANDI, PENDING:** [`d7e47d93`](https://github.com/orhanbal/webrising-commender/commit/d7e47d934faaa14ad8adab41334bd663b69791b2) gerçek MCP→Gateway→Rust Agent E2E'de allowlist dışı dosyaya symlink üzerinden `fs_read`, `fs_read_lines`, `fs_replace` reddini ve hedef içeriğinin değişmemesini doğrular. Rust unit final-component swap simülasyonu eklenmiştir.
- **D / FAILED → FIXED CODE, CI PENDING:** [CI #40111108878](https://github.com/orhanbal/webrising-commender/actions/runs/40111108878) `rust` job `cargo fmt --check` biçim hatası gösterdi. [`7567af97`](https://github.com/orhanbal/webrising-commender/commit/7567af97d4dc6b6dea05771a75b99468a47be0d3) bu diff'i düzeltti; [CI #40111188325](https://github.com/orhanbal/webrising-commender/actions/runs/40111188325) son kodun 17 job sonucu ve artifact'leri tamamlanmadan **PASSED** sayılmaz. Bu belge commitinin kendi CI'sı da ayrıca kontrol edilir.
- **Kalan risk ve kuyruk:** Bu koruma yalnız son path bileşeninin symlink değiştirilmesini sınırlar; üst dizinlerin eşzamanlı yeniden adlandırılması için descriptor-relative/openat benzeri tam yarış güvenliği henüz **PENDING**. **1A** gerçek native streaming/pause/resume; **1B** çalışan taramayı checkpoint'ten restart sonrası sürdürme; **1C/1D/3A** tam OS/stress/race kabulü **PENDING**. 2A–10D kuyruğu açık; **7B/10C BLOCKED_EXTERNAL**. Tam Desktop Commander eşdeğerliği **PENDING**.
- **Kapsam:** Yalnız `orhanbal/webrising-commender/main`; başka repo, üretim, sunucu, Desktop Commander/Remote Desktop Commander kullanılmadı.

## 24 Ekim 2026 19.14 TRT — A: kırmızı CI düzeltildi, 1A/1B kabulü açık

- **FAILED (giriş HEAD):** `55da5480db6bcb007df286a502e8f523be22fa5e`, [CI #40108369178](https://github.com/orhanbal/webrising-commender/actions/runs/40108369178): 16/17 job PASSED; `integration` FAILED. Gerçek job `120914763009` logunda `gateway/test/integration.mjs:241` `outboxStatus.counts.sent >= 1` assertion hatası. SMTP test sunucusu mesajı kaydetmişti, ancak asenkron mail worker'ın `sent_at` veritabanı güncellemesi henüz görünür değildi.
- **FIX COMMITTED:** [`54c4ee7c`](https://github.com/orhanbal/webrising-commender/commit/54c4ee7c998f029e47d44826de0c7317ca98b7b8) yalnız `gateway/test/integration.mjs` testindeki gönderim durumunu `waitFor` ile en çok 8 saniye bekler; güvenlik assertion'ları, gerçek SMTP gönderimi ve veritabanı kalıcılığı kontrolü korunur. Runtime davranışı veya araç şeması değiştirilmedi.
- **PASSED (düzeltme kod HEAD'i):** [CI #40110624425](https://github.com/orhanbal/webrising-commender/actions/runs/40110624425), `54c4ee7c998f029e47d44826de0c7317ca98b7b8`: **17/17 job success** (`integration`, `gateway`, `agent-e2e`, `rust`, `relay-e2e`, OS build/smoke). Dört artifact: `dashboard-visual-acceptance`, `WECOMMANDER-linux-x64-acceptance`, `WECOMMANDER-macos-universal-acceptance`, `WECOMMANDER-windows-x64-acceptance` (hepsi non-expired).
- **B/C — PENDING:** Bu çalışmada girişte kritik kırmızı CI bulunduğundan 1A streaming/pause-resume veya 1B restart-checkpoint üzerinde doğrulanmamış yeni özellik yazılmadı. 1A/1B birinci sırada kalır; 1C fiziksel stres kabulü ve 1D–10D sonraki kuyruktadır. 46 MCP araç sözleşmesi değişmedi.
- **D — PENDING (bu doküman HEAD'i):** Yukarıdaki 17/17 yalnız `54c4ee7c` kod HEAD'i içindir; bu belge commitinin kendi CI'sı ayrıca doğrulanmalıdır. Fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imza/SmartScreen ve Apple notarization **BLOCKED_EXTERNAL**. Tam parity **PENDING**.
- **Kapsam:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer repo/Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli/sınırlı runtime eklenmedi.

## 24 Ekim 2026 — 1C: çoklu Gateway ortak native arama kotası

- **A / MEVCUT KOD:** [a33ec3d6](https://github.com/orhanbal/webrising-commender/commit/a33ec3d6f7dd0e8ceea28fba6f97f5f86c7e183a) aynı organizasyon/kullanıcının farklı cihazlarda tek bir eşzamanlı arama kotasını paylaşmasını sağlar; [1b79899a](https://github.com/orhanbal/webrising-commender/commit/1b79899a784e3a3a8352ecba986d073884cb04c1) sınır, tenant izolasyonu ve durdurma yarışı unit testini ekler. Gateway job logunda unit test PASSED kanıtı görüldü; ilgili kod HEAD'i daha sonra dokümantasyon commitleriyle değişti.
- **B / DAĞITIK DÜZELTME KODLANDI:** [f13b3f6b](https://github.com/orhanbal/webrising-commender/commit/f13b3f6b1b4835bfe2eec33bd09e4147685e6f73) PostgreSQL transaction + advisory actor lock ile **Gateway'ler arası sekiz eşzamanlı native işlem** kotasını uygular. `native_inflight` alanı durdurulan işlemin fiziksel sonucuna kadar kotada kalmasını sağlar. Durum geçişleri aynı actor/organization/device kapsamında SQL CAS ve explicit native settlement ile korunur; ölü Gateway için 15 saniyelik heartbeat lease kullanılır.
- **C / GERÇEK POSTGRESQL E2E:** İlk [CI #40107913863](https://github.com/orhanbal/webrising-commender/actions/runs/40107913863) entegrasyon işi, test harness'ının `pg.Client` üzerinde tekrar connect denemesi nedeniyle FAILED. [cd339dda](https://github.com/orhanbal/webrising-commender/commit/cd339dda1ffc21bf8f74c5592f1ec2ea14755fcc) testte gerçek `pg.Pool` kullanır ve iki farklı Gateway persistence instance'ıyla 8 aktif tarama, 9. ret, stop sonrası slotun korunması ve native settlement sonrası yeni tarama kabulünü doğrular. [CI #40108057584](https://github.com/orhanbal/webrising-commender/actions/runs/40108057584) üzerinde `gateway` ve `integration` job'ları **PASSED** görüldü; bütün CI tamamlanmadan **17/17 PASSED** ilan edilmez.
- **D / PENDING:** Bu doküman commitinin son HEAD CI'sı ayrıca beklenir. 1C fiziksel OS, yüksek eşzamanlılık ve stres kabulü hâlâ PENDING. **1A** native canlı streaming/pause/resume ve **1B** çalışan native taramayı checkpoint'inden Gateway restart sonrası sürdürme henüz uygulanmadı; 1D–10D kanonik kuyruk açık. **7B/10C BLOCKED_EXTERNAL** (fiziksel OS, canlı ChatGPT/Claude, Windows imzalama/SmartScreen, Apple notarization). Genel Desktop Commander parity **PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; diğer repo, üretim sunucusu ve Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 — 1C: kullanıcı başına eşzamanlı arama kotası (çoklu cihaz)

- **A / DOĞRULANDI:** Önceki native Rust biçimlendirme hatası [6ae9f2c5](https://github.com/orhanbal/webrising-commender/commit/6ae9f2c5d136944f4b2ece86dc6d8e16f78e3329) ile düzeltilmiş; eski [CI #40106428725](https://github.com/orhanbal/webrising-commender/actions/runs/40106428725) FAILED sonucu daha yeni HEAD için kabul değildir.
- **B / 1C KODLANDI:** [a33ec3d6](https://github.com/orhanbal/webrising-commender/commit/a33ec3d6f7dd0e8ceea28fba6f97f5f86c7e183a) Gateway içi aktif native arama kotasını kullanıcı-cihaz yerine **organizasyon + kullanıcı** düzeyinde uygular. Aynı kullanıcının cihaz değiştirerek sekiz eşzamanlı arama kotasını aşması engellenir. Durdurulmuş fakat Agent yanıtı henüz tamamlanmamış aramalar slot işgal etmeye devam eder.
- **C / REGRESYON EKLENDİ:** [1b79899a](https://github.com/orhanbal/webrising-commender/commit/1b79899a784e3a3a8352ecba986d073884cb04c1) aynı kullanıcı + dokuzuncu cihaz için ret, farklı kullanıcı/organizasyon izolasyonu, durdurulan yerel taramanın slotunun erken boşalmaması ve settle sonrası yeni oturum testleri ekler. Önceki 1C timeout regresyonları [49372753](https://github.com/orhanbal/webrising-commender/commit/49372753ff744fb5647a1236f693dd1c113c0b2e) ve [52416147](https://github.com/orhanbal/webrising-commender/commit/52416147e141cb0b6cd24509d669596009bb23b3) kayıtlıdır.
- **D / CI PENDING:** Kod HEAD'i `1b79899a784e3a3a8352ecba986d073884cb04c1` için [CI #40107310735](https://github.com/orhanbal/webrising-commender/actions/runs/40107310735) başlatıldı; tüm işler tamamlanmadan PASSED denmeyecek. Bu plan commitinin kendi HEAD CI'sı ayrı doğrulanmalıdır.
- **Açık kabul:** Çoklu Gateway üzerinden **dağıtık kota** henüz uygulanmadı; 1C'nin OS/stres/race kabulü PENDING. **1A** native gerçek zamanlı streaming ve pause/resume, **1B** çalışmakta olan taramayı restart sonrası checkpoint'ten sürdürme PENDING. 1D–10D kuyruk görevleri açık; 7B/10C fiziksel OS, canlı ChatGPT/Claude ve imzalama/noter kanıtı BLOCKED_EXTERNAL. Desktop Commander işlevsel eşdeğerliği PENDING.
- **Sınır:** Sadece `orhanbal/webrising-commender/main`; diğer depolara, üretim sunucularına veya Remote Desktop Commander'a dokunulmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 18.20 TRT — A/B/C/D: dayanıklı arama sayfalama ve native silinme yarışı

- **A / PASSED (giriş HEAD):** `58829a87d0926b6fa9387053856e5c6c57ad3ed3` üzerinde [CI #40101907731](https://github.com/orhanbal/webrising-commender/actions/runs/40101907731) **17/17 PASSED**, [platform #40102369794](https://github.com/orhanbal/webrising-commender/actions/runs/40102369794) **PASSED**. Gerçek `rust`, `agent-e2e`, `gateway` job sonuçları/logları okundu. Bu kanıt yeni HEAD'e taşınmaz.
- **B / 1D PENDING (gerçek düzeltme):** [`771327d4`](https://github.com/orhanbal/webrising-commender/commit/771327d4ad8156526faf08466caa802bd43913d7) PostgreSQL kalıcı arama sonuçları 1 MiB sınırını aştığında tüm sayfaları sıfırlamak yerine UTF-8 byte hesabıyla en uzun **sıralı öneki** tutar; `truncated=true`, 500 sonuç sınırı, actor/tenant/device ve CAS stop koruması değişmez. [`b7e89f6c`](https://github.com/orhanbal/webrising-commender/commit/b7e89f6c152200c5bd7ce9e62e12719d805d3b34) TypeScript UTF-8/500-item/korunan-sıra negatif testleri; [`2dadd539`](https://github.com/orhanbal/webrising-commender/commit/2dadd539533867baeea303096c41e05598772b7d) gerçek PostgreSQL restart-benzeri sayfalama, son sayfa ve stop sonrası veri silinmesi E2E testi ekler.
- **C / 1C PENDING (native yarış düzeltmesi):** [`40c0c1fc`](https://github.com/orhanbal/webrising-commender/commit/40c0c1fc0fa315bf5c132c42d35e6a0b5d459d15) Rust `fs_search` ve `text_search` sırasında `read_dir`/metadata arasında silinen girdileri atlar; diğer IO/izin hatalarını saklamaz, symlink izlemez. Deterministik silinmiş dosya unit regresyonu eklendi. Çoklu OS/stres kabulü açık.
- **D / PENDING (yeni HEAD):** [CI #40106428725](https://github.com/orhanbal/webrising-commender/actions/runs/40106428725) yeni kod için başlatıldı; tüm 17 job ve artifact'ler tamamlanmadan **PASSED** yazılmaz. Bu belge commitinin HEAD CI'sı ayrıca kontrol edilecek.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve gerçek uzun tarama kabulü), **1B PENDING** (çalışan taramanın Gateway restart sonrası kaldığı yerden devamı), **1C PENDING**, **1D PENDING** (geniş OS/stress/çıktı kabulü). **2A–10D PENDING** kanonik kuyrukta, **7B/10C BLOCKED_EXTERNAL** fiziksel OS, canlı ChatGPT/Claude, Windows imza/SmartScreen, Apple notarization. **Eşdeğerlik PENDING**.
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer depo/Desktop Commander/Remote Desktop Commander kullanılmadı; ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 17.18 TRT — A/B/C/D, 1A native içerik iptali ve 1D bounded dosya okuma

- **A — PASSED (giriş):** Başlangıç HEAD `93c926cc` için [CI #40098399194](https://github.com/orhanbal/webrising-commender/actions/runs/40098399194) **17/17 PASSED**, [platform #40098783921](https://github.com/orhanbal/webrising-commender/actions/runs/40098783921) **PASSED**; `rust`, `agent-e2e`, `gateway` job logları okundu. İlk yeni kodun `rust` job'ı `cargo fmt --check` nedeniyle FAILED; gerçek rustfmt diff'i `f74f7655` ile düzeltildi, **son HEAD CI PENDING**.
- **B — 1A PENDING (gerçek Rust iyileştirmesi):** [`b4bb67e7`](https://github.com/orhanbal/webrising-commender/commit/b4bb67e728ea7531b28fad8ed794ba62aeaa1068) içerik taramasındaki tek seferlik `read_to_string` yerine 16 KiB parçalarda, aralarda `AtomicBool` iptali ve monotonic deadline kontrolü yapan en çok 1 MiB okuma getirdi. İptalin dosya okunurken gerçekleşmesini taklit eden deterministik Rust unit eklendi. **Native progress streaming, pause/resume ve uzun gerçek tarama benchmark'ı hâlâ PENDING; 1A tamamlandı sayılmaz.**
- **C — 1D PENDING (bounded okuma + negatif E2E):** `fs_read_lines` için metadata ile gerçek okuma arasındaki büyüme yarışında 32 MiB + 1 bayt fiziksel sınır eklendi. [`f1c5b4ec`](https://github.com/orhanbal/webrising-commender/commit/f1c5b4ec1d25dee2331b1351061856b6a2235f07) ve [`6c541773`](https://github.com/orhanbal/webrising-commender/commit/6c541773f70d52103f881f1b575ba1dd5d98665f) gerçek MCP → Gateway → Agent E2E'de içerik araması 1 MiB sınırı, 32 MiB paged-read reddi ve bozuk UTF-8 reddi ekledi. Mevcut 46 MCP araç şeması, allowlist ve actor/tenant/device denetimi korunur; yeni araç veya ücretli bağımlılık yok.
- **D — PENDING:** [`f74f7655`](https://github.com/orhanbal/webrising-commender/commit/f74f7655b8d90235da3925add2a907b3cd789e5b) rustfmt düzeltmesi. [CI #40101863534](https://github.com/orhanbal/webrising-commender/actions/runs/40101863534) kod HEAD'i için başlatıldı; tüm job/artefact sonucu görülmeden PASSED yazılmaz. Bu plan commitinin kendi HEAD CI'sı ayrıca denetlenecek.
- **Kuyruk:** **1A PENDING**, **1B PENDING** (çalışan tarama restart sonrası kaldığı yerden devam etmiyor), **1C PENDING**, **1D PENDING** (OS/stress/büyük çıktı kabulü açık); **1D–10D** diğer açık işler mevcut kanonik kuyrukta. **7B/10C BLOCKED_EXTERNAL** (fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, Windows imza ve Apple notarization). **Eşdeğerlik PENDING.**
- **Sınır:** Sadece `orhanbal/webrising-commender/main`; üretim/sunucu/başka repo/Desktop Commander/Remote Desktop Commander kullanılmadı.

## 24 Ekim 2026 16:22 TRT — A/B/C/D: native multi-file read, güvenlik ve CI düzeltmesi

- **A — PASSED (giriş):** `02ee2ab3` üzerinde [CI #40093405056](https://github.com/orhanbal/webrising-commender/actions/runs/40093405056) **17/17 PASSED**, [platform #40093754504](https://github.com/orhanbal/webrising-commender/actions/runs/40093754504) **PASSED**. `rust`, `agent-e2e` ve `integration` logları incelendi; eski CI sonucu yeni HEAD'e aktarılmadı.
- **B — 1D IMPLEMENTED, kabul PENDING:** [`b4587f9e`](https://github.com/orhanbal/webrising-commender/commit/b4587f9e3dd1f3e7c7ad806328456a570af78706) `fs_read_multiple` için 1–10 dosyayı **tek native Rust Agent çağrısıyla** okuyan bounded yol ekler. MCP şeması, TypeScript action validation/risk, Agent enum/risk/allowlist, native read ve E2E uyumludur; her dosyanın hatası ayrı döner. Gateway'in önceki 10 ayrı Agent isteği kaldırıldı. Dosya başına 64 KiB sınır ve redakte `read_failed` kodu uygulanır. Araç sayısı değişmez (**46**).
- **C — TESTS ADDED, CI PENDING:** Gerçek Agent MCP E2E'de 10 dosya, kısmi hata, allowlist dışı yolun sızdırılmaması, sıfır/11 dosya, limit aşımı ve okuma sınırı; TypeScript Zod negatif kontrat testleri eklendi. Bunlar ilgili HEAD CI tamamlanmadan PASSED değildir.
- **D — CI FIX / PENDING:** İlk kod HEAD'i [CI #40097800013](https://github.com/orhanbal/webrising-commender/actions/runs/40097800013) `cargo fmt --check` adımında **FAILED**; gerçek diff incelenip [`36964592`](https://github.com/orhanbal/webrising-commender/commit/36964592a4c034f07ab9cc22a758bcf7c697dc07) ile Rust biçimi düzeltildi. [CI #40097863619](https://github.com/orhanbal/webrising-commender/actions/runs/40097863619) yeni kod HEAD'inin sonucudur; tam 17 iş, platform artifact ve bu dokümantasyon commitinin son HEAD CI'sı ayrıca kontrol edilmelidir.
- **Kuyruk:** **1A PENDING** (native streaming/pause-resume ve uzun tarama iptal kabulü); **1B PENDING** (çalışan taramanın restart sonrası sürdürülmesi); **1C PENDING** (OS/stress/race); **1D PENDING** (yeni native batch CI/OS kabulü ve satır/büyük çıktı uçları). **7B/10C BLOCKED_EXTERNAL**; diğer 1D–10D eksikler kuyrukta. **Genel eşdeğerlik PENDING.**
- **Kapsam:** Sadece `orhanbal/webrising-commender/main`; üretim, sunucu, başka repo, Desktop Commander veya Remote Desktop Commander kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim 2026 — A–D arama izolasyonu ve içerik case-sensitivity kabul kaydı

- **Giriş kanıtı:** `b222da7a`, [CI #40091796139](https://github.com/orhanbal/webrising-commender/actions/runs/40091796139) **17/17 PASSED**, [platform #40092082366](https://github.com/orhanbal/webrising-commender/actions/runs/40092082366) PASSED.
- **1A PENDING:** [`4ed6397b`](https://github.com/orhanbal/webrising-commender/commit/4ed6397bd11185f644a37d10ae2a6c450812f3f4) gerçek Agent üzerinden iki paralel arama ve birinin iptalinin diğerini bozmaması için MCP E2E ekler; native streaming/pause/resume ve uzun tarama iptal kabulü hâlâ açık.
- **1C PENDING:** [`31e3770a`](https://github.com/orhanbal/webrising-commender/commit/31e3770a00044337c7be530e53d36edb129fe4d8) içerik aramasının doğrudan ve oturumlu case-sensitive/insensitive MCP E2E'sini ekler.
- **Son HEAD CI PENDING:** [#40093339478](https://github.com/orhanbal/webrising-commender/actions/runs/40093339478) kod CI'sı ve bu belge commitinin CI'sı tamamlanmadan yeni testler PASSED sayılamaz. 46 MCP araç adı değişmedi. Fiziksel cihaz, canlı ChatGPT/Claude, imza/noter **BLOCKED_EXTERNAL**; eşdeğerlik **PENDING**. Ayrıntı: [kanonik kuyruk](HOURLY_BACKLOG_QUEUE_20261024.md).

## 24 Ekim — 1C büyük dizin / güvenli arama kabulü

- **Giriş kabulü:** `e7256adc` [CI #40088982183](https://github.com/orhanbal/webrising-commender/actions/runs/40088982183) **17/17 PASSED**, [platform #40089288689](https://github.com/orhanbal/webrising-commender/actions/runs/40089288689) PASSED.
- **1C — kodlanan test paketi:** `7b101537` ile gerçek Rust Agent E2E'de **530 dosya**, maksimum **500 sonuç**, `truncated`, son 10 sonuçta offset 490/length 30, son sayfa `hasMore=false`, uygunsuz offset, 101 eleman uzunluğu ve 1025 karakter sorgu negatif kontrolleri eklendi. [CI #40091456300](https://github.com/orhanbal/webrising-commender/actions/runs/40091456300) içinde `agent-e2e`, `gateway`, `integration` işleri PASS; bütün CI ve artifact kontrolü sürüm HEAD'ine göre ayrıca teyit edilir.
- **1C — bu belgeyle birlikte yeni negatif test:** İzin verilen arama kökünden dışarıdaki dizine işaret eden symlink üzerinden dosya adı veya içerik sorgusunun dış veri döndürmemesi; fiziksel Linux Agent E2E koşusu yeni HEAD CI sonucuna tabidir. Üretim/sunucular test edilmedi.
- **Kalan:** 1A gerçek native streaming ve pause/resume; 1B yeniden başlatmadan sonra *çalışan taramayı* sürdürebilme; 1C kalan çoklu OS/stress/race kabulü; 1D–10D ana görev kuyruğu **PENDING**. Gerçek ChatGPT/Claude ve fiziksel cihaz onayı **BLOCKED_EXTERNAL**. **Genel eşdeğerlik PENDING**.

## 24 Ekim 14:11 TRT — A/B/C/D, cross-Gateway native search cancellation

- **A / PASSED (giriş):** `e53f30ef` [CI #40088408188](https://github.com/orhanbal/webrising-commender/actions/runs/40088408188) **17/17 PASSED**; [platform #40088728355](https://github.com/orhanbal/webrising-commender/actions/runs/40088728355) PASSED. `0fb9254c` gerçek Gateway SIGKILL/restart E2E testini CI'ya ekledi; bu yeni testin kendi CI'sı ayrı doğrulanır.
- **B / IMPLEMENTED, CI PENDING (1B kalan dilim):** `1dd8091f` `PgSearchPersistence.stoppedIds` ile yalnız **aynı origin_instance** ve aktif UUID kümesine ait, DB'de durdurulmuş aramaları döndürür. Başka Gateway üzerinden `stop_search` sonrası owning Gateway saniyelik tek toplu sorguyla `AbortController` iptalini gerçek native/relay zincirine iletir. DB kesintisinde native zaman sınırı devam eder; tamamlanmış sonuçları diriltmeye izin verilmez.
- **C / TESTS ADDED:** Unit: yanlış ID başka aramayı iptal etmez; doğru ID yalnız ilgili native sinyali iptal eder; boş küme DB sorgusu yapmaz; SQL origin guard doğrulanır. PostgreSQL integration: farklı store üzerinden stop → owning store stoppedIds doğrulanır. **Canlı iki Gateway + gerçek Rust Agent uzun tarama iptal benchmark'ı henüz yok.**
- **D / PENDING:** [Kod HEAD CI #40088922971](https://github.com/orhanbal/webrising-commender/actions/runs/40088922971) yeni commit için başlatıldı; tüm 17 iş ve artifact'ler tamamlanmadan PASSED yazılmaz. Bu doküman commitinin de ayrı HEAD CI sonucu kontrol edilir.
- **Kuyruk:** **1A PENDING** (gerçek streaming/pause/resume eksik); **1B PENDING** (completed snapshot restart sürekliliği mevcut; çalışan scanner restart sonrası kaldığı yerden başlamıyor); **1C–10D** diğer açık kabul kapıları değişmedi. **7B/10C BLOCKED_EXTERNAL** (canlı istemciler, fiziksel OS, imzalama/noter). **Eşdeğerlik PENDING.**
- **Sınır:** Yalnız `orhanbal/webrising-commender/main`; üretim/sunucu/diğer depo/Desktop Commander araçları kullanılmadı. Ücretli runtime bağımlılığı eklenmedi.

## 24 Ekim — P0 1B PostgreSQL arama oturumu kalıcılığı

- **A / baseline:** Önceki tam doğrulanan `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) **17/17 PASS** ve [platform #40086302889](https://github.com/orhanbal/webrising-commender/actions/runs/40086302889) PASS. Daha yeni HEAD'e bu sonucu taşımayın.
- **B / IMPLEMENTED, CI PENDING:** `fc51c76c` PostgreSQL `search_sessions` migration, actor/organization/device-scoped 5dk TTL, en fazla 500 eşleşme ve 1MiB kalıcı sonuç sınırı, error/stop kayıtları ve housekeeping. `start_search`, `get_more_search_results`, `list_searches`, `stop_search` persistent fallback kullanır. Çalışır durumdaki native scanner otomatik devam ettirilmez; yeniden başlatılmış Gateway'in sahip olmadığı `running` iş `search_interrupted` görünür.
- **C / TESTS ADDED, CI PENDING:** `f70a13ed` async search-page/stop/list kontratı ve TypeScript unit; `c9dbfe2e` izolasyon/rollback/sınır mock regresyonu; `1e0d6dc2` gerçek PostgreSQL integration: tamamlanmış aramayı yeni store örneğinden okumak, actor/tenant/device negatif izolasyon, stop sonrası temizleme, yarım taramayı `search_interrupted` gösterme.
- **D / PENDING:** Son doküman HEAD'inin 17/17 CI ve dağıtım artifact kabulü, gerçek Gateway sürecini kapatıp açan uçtan uca restart senaryosu, çoklu Gateway/failover eşzamanlı durdurma, uzun bölgesel native cancellation ve 1A streaming/pause kabulü açık. **Eşdeğerlik ilan edilmez.**
- **BLOCKED_EXTERNAL:** Fiziksel Windows/macOS/Ubuntu, canlı ChatGPT/Claude, platform imzaları ve Apple notarization kanıtlanmadı.

## 24 Ekim — Bölgesel relay arama iptali (1A, A/B/C/D)

- **A:** Giriş `4730d2e9` için [CI #40085991556](https://github.com/orhanbal/webrising-commender/actions/runs/40085991556) 17/17 başarılı; üretim, fiziksel cihaz ve dış MCP kabulü yapılmadı.
- **B:** `91506f9e` — `DeviceRouter` bölgesel relay isteklerine eşsiz UUID ekler; `AbortSignal` geldiğinde ayrı **imzalı** `/internal/relay/cancel` çağrısını kullanır. Uzak `AgentHub` cancel sinyalini native Agent'a iletir. Asıl HTTP isteği kooperatif bitişe kadar bekler; eşzamanlı tarama kotası erken boşaltılmaz.
- **C:** `relay-cancellation.ts` — farklı sırada ulaşan cancel/request çağrıları için TTL'li ve kapasiteli erken iptal kaydı; `requestId + deviceId` eşleşmesi, çakışma ve yanlış cihaz testleri. Bölgesel relay E2E'ye unsigned cancel=401, gerçek MCP start/stop/page yarış testi eklendi.
- **D:** Bu belge güncellemesinin **yeni HEAD CI sonucu PENDING**. Canlı uzun süren bölgesel arama üzerinde iptal süre/maliyet benchmark'ı, streaming ve pause/resume ile 1B kalıcı oturum **PENDING**; genel eşdeğerlik **PENDING**. 

## 13.11–13.25 A/B/C/D ilerleme kaydı — 24 Ekim 2026

- **A / PASSED (giriş):** `7d4ff46b` için [CI #40081678744](https://github.com/orhanbal/webrising-commender/actions/runs/40081678744) **17/17 PASS**; [platform #40082053980](https://github.com/orhanbal/webrising-commender/actions/runs/40082053980) PASS. Rust, Agent E2E ve integration job logları incelendi; giriş HEAD'inde kırmızı iş yoktu.
- **B / PENDING (1A native cancellation):** `c602a7ad` ile Rust Agent aramaları `spawn_blocking` üzerinde çalışıyor; istek bazlı `AtomicBool` iptal bayrağı tarama döngüsü/dizin/satır sınırlarında kontrol ediliyor. WebSocket `cancel` geldiğinde search task'ı körlemesine abort edilmek yerine kooperatif çıkış yapıyor; disconnect/shutdown bayrakları temizliyor. Pre-cancelled Rust negatif testi eklendi.
- **C / PENDING (1A Gateway cancel iletimi):** `0ad37183` ile `stop_search` → AbortSignal → local AgentHub → WebSocket `cancel` → native Agent zinciri kuruldu. Gateway in-flight kotası, Agent yanıtı veya timeout gelene kadar korunuyor; sonuçlar stop sonrası geri dönmüyor. Actor/device izolasyonu korunuyor. Gateway negatif yarış testi eklendi.
- **D / PASSED (ara kod kontrolü):** `4071130f` rustfmt, `6f3eca4f` clippy ExecutionContext ve `523e532e` biçim düzeltmeleri. [CI #40085512074](https://github.com/orhanbal/webrising-commender/actions/runs/40085512074) kod HEAD'i için başlatıldı; son durum ayrıca kontrol edilmeli. İlk CI kırmızıları (fmt/clippy) düzeltildi.
- **Açık 1A:** Gerçek streaming ve pause/resume yok. Yerel relay için fiziksel iptal uygulanmış olsa da uçtan uca yavaş tarama sırasında durdurma testi ve bölgesel relay üzerinden iptal iletimi henüz doğrulanmadı; bu nedenle 1A **PENDING**.
- **Açık 1B:** PostgreSQL kalıcı arama oturumu ve restart sonrası actor/tenant/device izolasyonu **PENDING**. `stop_search` ile durdurulmuş snapshot hiçbir koşulda tekrar görünür olmamalı.
- **BLOCKED_EXTERNAL:** Gerçek Windows/macOS/Ubuntu fiziksel kurulum, canlı ChatGPT/Claude ve Windows/Apple imzalama/noter kanıtları yok. Eşdeğerlik **PENDING**.
- **Sonraki öncelik:** CI yeşilse 1A native streaming/pause, regional relay cancel ve 1B kalıcı search-session; kırmızıysa önce CI.

## 12.14 A–D güncellemesi — P0 arama ve 40 işlik kuyruk (2026-10-24)

- **Giriş kanıtı:** `cf8387fa` üzerinde [ci #40080662828](https://github.com/orhanbal/webrising-commender/actions/runs/40080662828) 17/17 PASS ve [platform #40080948491](https://github.com/orhanbal/webrising-commender/actions/runs/40080948491) PASS. Yeni HEAD için bu sonuç geçerli sayılmaz.
- **Yeni kod (CI PENDING):** `3db2cb23` + `e1fe01c5` search in-flight concurrency quota, stop yarışı ve güvenli hata redaksiyonu; `cf41f58f` + `5c67b09b` + `93809aaa` native 10s monotonic arama bütçesi, `timedOut` sinyali ve Rust/Agent E2E testleri.
- **Açık:** Gerçek streaming/pause/cancel, Gateway restart sonrası arama oturumları, kalıcı PTY, rollback, belge araçları, fiziksel OS/ChatGPT/Claude kabulü. `stop_search` native scan'i hâlâ fiziksel olarak iptal etmez.
- **Kanonik durum:** [40 alt görevlik 1A–10D kuyruk ve A/B/C/D kanıtları](HOURLY_BACKLOG_QUEUE_20261024.md). Eşdeğerlik **PENDING**.

# WECOMMANDER — Desktop Commander İşlevsel Eşdeğerlik Planı

## 08.00 kapanış kontrolü — 24 Ekim 2026

- **PASS / son tamamen doğrulanan baseline:** `5c9d860a7b83186f60457e0046f4b25e91eacc92` için GitHub Actions `ci #40060563045` **17/17 PASS**, `platform-distribution #40060992297` PASS. CI artifact'leri: `WECOMMANDER-windows-x64-acceptance`, `WECOMMANDER-linux-x64-acceptance`, `WECOMMANDER-macos-universal-acceptance` ve `dashboard-visual-acceptance`. Bunlar **gerçek fiziksel kurulum kabulü değildir**.
- **KODLANDI / yeni HEAD CI bekliyor:** `948ed6a3` ile bilinmeyen MCP araç adı, cihaz/tenant DB sorgusu yapılmadan `unknown_tool` hatasıyla reddediliyor. `97413956` ile gerçek Gateway entegrasyon testine araç adları tekilliği, JSON şeması, gerekli `device_id`, HIGH onay parametresi ve bilinmeyen araç regresyonu eklendi.
- **SÖZLEŞME ENVANTERİ:** `plans/MCP_TOOL_CONTRACT_MATRIX_20261024.md` dosyasında 46 kayıtlı MCP aracı, risk/yönlendirme ve doğrudan Linux Agent E2E fixture varlığı ayrıştırıldı; 35 aracın doğrudan test çağrısı mevcut. **Test çağrısı varlığı, o aracın bütün davranışları veya tüm işletim sistemleri için kabul anlamına gelmez.**
- **PENDING:** Bu son kod/test/belge commit'lerinin bulunduğu **güncel `main` HEAD** üzerinde CI, platform artifact'leri ve gerçek istemci kabulü. Önceki baseline PASS yeni HEAD'e otomatik taşınmaz.
- **AÇIK / P0:** Native akışlı aramayı iptal/askıya alma, Gateway restart sonrası arama oturumları, disk kalıcı PTY geçmişi, REPL/prompt, süreç ağacı temizleme, dosya rollback/sürümleme.
- **AÇIK / P1:** PDF araçları; DOCX biçim koruyan düzenleme; görsel önizleme; XLSM güvenli yazma; karmaşık OOXML roundtrip; performans/regresyon matrisi.
- **AÇIK / P2:** Gerçek ChatGPT/Claude MCP bağlantısı, fiziksel Windows/macOS/Ubuntu kurulum/upgrade/uninstall, kullanıcı paneli tam işlev kabulü, Windows imzası ve macOS noter onayı.
- **Karar:** `Desktop Commander parity achieved` **HAYIR**. CI'da derlenebilirlik ve genel entegrasyon, canlı ürün eşdeğerliği değildir.


Son gözden geçirme: 2026-10-24. Öncelik: eşdeğerlik > güvenilirlik/kabul > farklılaşma. Yeni SaaS/ticari özelliklere girilmeden önce aşağıdaki kapsamdaki eksikler kapatılacak.

## Güncel uygulama durumu (2026-10-24 02.00 CI/P0 doğrulaması)
- **CI PASS (kanıt):** `930b5e7931eb9d09b61b97688a6aa92e926ad79b` commit'inde `ci` run `40036280462` içindeki **17/17 job başarıyla tamamlandı** (Rust, Windows/macOS derlemeleri, Linux gerçek Agent E2E, gateway/integration, Compose, Windows service smoke, kurulum syntax, kabul artifact'leri). `platform-distribution` run `40036735981` de başarılı.
- **Yeni test commit'i, henüz kabul değil:** `97e584f8ec7db1829c05bd5bdcf6cf7259e010f4` ile gerçek Agent E2E'ye 10 dosyalı batch, 11 dosyalı negatif sınır, dosya boyutu limiti, asenkron arama oturumu başlat/sonuç sayfalama/durdurma ve geçersiz sayfa testi eklendi. Bu commit'in CI sonucu ayrıca doğrulanmadan PASS sayılmaz.
- **CI'da mevcut P0:** `fs_read_lines` pozitif/negatif satır sayfalama, `fs_read_multiple` (1–10), actor/tenant/cihaz izole arama oturumları, `get_recent_tool_calls`, `get_usage_stats`, `terminal_read_page`, atomik dosya yazma, `fs_append`, `fs_replace` SHA-256 önkoşulu ve `policy_info`. Her birinin kapsamı ilgili testlerin doğruladığı kadar kabul edilir.
- **Kısmi:** Arama oturumları asenkron snapshot sağlar; Agent tarafında gerçek akışlı arama/askıya alma yok. Gateway yeniden başlatıldığında oturumlar kaybolur. PTY çıktı geçmişi son 1 MiB ile sınırlıdır; kalıcı tam çıktı sayfalama yok. Atomik yazma mevcut olsa da otomatik rollback/sürümleme yok.
- **Açık:** Excel/DOCX/PDF formatlarına özel araçlar, gerçek ChatGPT/Claude MCP kabulü, üç OS fiziksel kabulü, platform imzalama/noter, kullanıcı paneli tam işlev kabulü.
- `main` HEAD her zaman kabul edilmiş sürüm değildir. Her yeni commit'in CI sonucu ve Agent E2E kanıtı ayrıca doğrulanır.

## 03.00 P0 arama güvenilirliği — uygulanan düzeltme (2026-10-24)

- **Önceki kanıtlı baseline:** `00a5fe63` üzerinde `ci #40037548484` PASS ve `platform-distribution #40038012018` PASS.
- **KODLANDI / güncel HEAD CI bekliyor:** Native `fs_search` daha önce her zaman küçük/büyük harfe duyarsızdı; `start_search(search_type=files, case_sensitive=true)` parametresi sessizce yok sayılıyordu. Rust `AgentAction`, dosya arama fonksiyonu, Gateway Zod protokolü, MCP şeması ve oturum yönlendirmesinde `caseSensitive` uçtan uca geçiriliyor; varsayılan eski davranış (`false`) korunuyor.
- **KODLANDI / test eklendi:** Gerçek Agent MCP E2E'de `CaseMatch.txt` / `casematch.txt` ayrımı ve oturum sonuç sayfalaması; Gateway unit testinde arama parametresi iletimi.
- **KODLANDI / test eklendi:** `stop_search` ile durdurulan oturumun aynı kullanıcı için eşzamanlılık kotasını tüketmemesi, global limit dolduğunda durmuş oturumların geri kazanılması. Durmuş oturumun sayfalı durum sorgusu geçici süre boyunca korunur.
- **PENDING:** Güncel kod HEAD `959ed2a4` için GitHub Actions CI run `40043081577` başlatıldı; sonucu görülmeden kabul PASS değildir.
- **AÇIK:** Gerçek native akışlı arama ve iptal, yeniden başlatmada oturum devamlılığı, kalıcı terminal geçmişi ve sürüm/rollback. `stop_search` şu an yalnızca Gateway sonuçlarını durdurur; devam eden native taramayı fiziksel olarak iptal etmez.

## 04.00 P0 terminal geçmişi ve sayfalama (2026-10-24)

- **PASS / giriş HEAD:** `67332a8a` için `ci #40043353106` 17/17 ve platform dağıtımı `#40043712961` başarılı.
- **KODLANDI:** Rust Agent PTY çıktısında tüketici `terminal_read` kuyruğu ile bağımsız, 1 MiB sınırlı, non-consuming `terminal_read_page` geçmişi. `terminal_read` geçmişi artık silmiyor; pozitif offset tüm PTY akışındaki mutlak bayt konumunu, negatif offset sondan okumayı gösteriyor.
- **KODLANDI:** Taşma sonrası `retainedStartBytes`, `totalOutputBytes`, `truncatedBeforeOffset` alanları ile eksik geçmiş açıkça bildiriliyor. `nextOffsetBytes` mutlak imleçtir. MCP açıklaması ve Gateway güvenli tamsayı doğrulaması güncellendi.
- **TEST:** Rust unit testi taşma, tail, mutlak sayfalama; gerçek Linux Agent E2E testi `terminal_read` sonrası geçmişin korunması ve mutlak imleçten yeniden okuma; Gateway protokol testi büyük mutlak offset ve güvenli tamsayı sınırı.
- **CI / PASS:** Kod + plan güncellemesi HEAD `03a618d2` için GitHub Actions `ci #40048337156` **17/17 PASS** (Rust, Gateway, Linux Agent E2E, Windows/macOS derlemeleri, installer/artifact işleri ve güvenlik entegrasyonu). Bu belge güncellemesi yeni HEAD oluşturacağı için onun CI'sı ayrıca doğrulanmalıdır.
- **AÇIK:** Geçmiş yalnızca Agent RAM'inde ve 1 MiB sınırında; Agent yeniden başlatması sonrası veya daha eski çıktı için disk tabanlı tam geçmiş yok. REPL/prompt algılama, process-tree cleanup, native search cancellation ve gerçek üç platform kabulü ayrıca açık.

## 05.00 P1 Excel / XLSX güvenlik ve regresyon (2026-10-24)

- **Kodlandı, güncel HEAD CI bekliyor:** `xlsx_inspect`, `xlsx_read_range`, `xlsx_find` ve `xlsx_write_cells` MCP → Gateway → native Rust Agent hattında mevcut. Gerçek Linux Agent E2E, XLSX okuma/arama ve yeni XLSX'e hücre düzenleme, kaynak hash önkoşulu, makro etkin XLSM düzenleme reddi, mevcut çıktı dosyasını ezmeme ve izin sınırlarını test ediyor.
- **Güvenlik düzeltmesi:** `c8a25876` arama eşleşmesindeki hücre içeriğini UTF-8 sınırlarını koruyarak en fazla 4096 bayt önizleme olarak döndürür ve `valueTruncated` alanını ekler. Önceden tek bir büyük hücre sınırsız MCP arama sonucu üretebiliyordu.
- **Eşzamanlı düzenleme düzeltmesi:** Aynı commit, XLSX kaydetme işlemi tamamlandıktan sonra, yeni dosya atomik yayımlanmadan hemen önce kaynak SHA-256 değerini yeniden denetler. Kaynak arada değişmişse yeni çıktı yayımlanmaz. Bu, tüm olası dosya sistemi yarışlarını ortadan kaldırdığı iddiası değildir.
- **Gerçek Agent E2E testi:** `bc76d202`, 6000+ karakterli XLSX hücresinin sonunda bulunan metni arar ve yanıttaki `valueTruncated=true` ile 4096 bayt önizleme sınırını doğrular.
- **PENDING:** Bu son iki kod/test commit'inin CI ve dağıtım kabulü; en son HEAD üzerinde bütün job'lar PASS olmadan tamamlandı sayılmaz.
- **AÇIK:** XLSM güvenli yazma (şimdilik yalnızca okuma), karmaşık OOXML parçaları için yazma (bilinçli olarak reddediliyor), formül ve stil roundtrip matrisi, fiziksel Windows/macOS kabulü ve performans testleri.

## 06.00 P1 DOCX okuma altyapısı (2026-10-24)

- **Önceki kanıtlı baseline:** `12d0a263` commit'i için GitHub Actions `ci #40054605923` **17/17 PASS**, `platform-distribution #40055044684` **PASS**.
- **KODLANDI / son HEAD kabul bekliyor:** Native Rust `docx_inspect`, `docx_read_paragraphs`, `docx_read_table` işlemleri; MCP araç tanımları, Gateway Zod protokolü, `AgentAction` LOW risk eşlemesi, Agent `spawn_blocking` hattı. Sadece DOCX okuma destekleniyor; DOCX düzenleme henüz YOK.
- **Güvenlik:** Allowed-root politikası, 16 MiB sıkıştırılmış/64 MiB açılmış ZIP limiti, 512 giriş sınırı, 8 MiB `word/document.xml` limiti, tekrar eden ana XML girişini reddetme, 128 KiB sonuç sayfası, Unicode-safe önizleme. Harici ilişki/URL veya makro yüklenmiyor.
- **TEST EKLENDİ:** Gerçek Agent ↔ Gateway ↔ MCP testinde deterministik DOCX fixture, Unicode/XML entity, paragraf sayfalama, tablo hücreleri, geçersiz sayfa, eksik tablo, bozuk ZIP ve izin verilen kök dışı dosya negatif testleri.
- **PENDING:** `3236ab30` kod commit'inin ve bu plan güncellemesinin güncel CI/Rust/Agent E2E sonucu; önceki `ci #40056654534` derlemesi clippy `cloned_ref_to_slice_refs` uyarısıyla durdu, düzeltildi. Yeni CI geçmeden PASS denmez.
- **AÇIK:** DOCX yapılandırılmış düzenleme/biçim koruma, PDF sayfa/metin/merge, görsel önizleme, fiziksel üç OS ve canlı MCP istemci kabulü.

## 07.00 P1 görüntü metaverisi (2026-10-24)

- Önceki DOCX HEAD `c3b87ce3` için CI `40056941079` 17/17 PASS ve dağıtım `40057255598` PASS.
- `image_inspect` MCP/Gateway/Rust Agent hattında başlık düzeyinde PNG/JPEG/GIF/VP8X WebP boyut ve MIME okur. Piksel çözme veya görsel önizleme **yok**. 32 MiB dosya, 256 KiB başlık, allowed-root ve uzantı kontrolü mevcut.
- Gerçek Linux Agent E2E'ye geçerli PNG/GIF ve bozuk/spoofed/out-of-root negatif testler eklendi. **Yeni HEAD CI PENDING**; başarılı sonuç görülmeden DONE değildir.
- PDF ve DOCX düzenleme, gerçek önizleme, fiziksel OS/ChatGPT/Claude kabulü açık.

## Karşılaştırma kaynağı
- Desktop Commander'ın yayımlanan MCP araç listesi: https://github.com/mcp/wonderwhy-er/desktop-commander
- Remote MCP araç listesi: https://github.com/mcp/app.desktopcommander/remote-desktop-commander
- Resmî site: https://desktopcommander.app/
- WECOMMANDER kanonik kaynak: `gateway/src/mcp.ts`, `gateway/src/protocol.ts`, `crates/agent/src/*` ve `gateway/test/agent-e2e.mjs`.
- Amaç üçüncü tarafın kaynak kodunu kopyalamak değil, belgelenmiş davranışlarda bağımsız eşdeğerlik sağlamaktır.

## Tamamlandı / kodda mevcut — yine de gerçek istemci kabulü gerekebilir
- [x] Cihaz eşleştirme; Windows gerçek cihazda online ve `whoami` denendi.
- [x] Windows/Ubuntu/macOS build + doğrudan kurulum paketleri; CI başarı 17/17 (commit `755779eb`). **Gerçek macOS/Ubuntu kurulum kabulü yapılmadı.**
- [x] Dosya listeleme, meta veri, metin/ikili okuma-yazma, taşıma, silme; allowlisted roots.
- [x] Metin arama, dosya adı arama, recursive tree ve korumalı tekil replacement.
- [x] Kısa komutlar, PTY oturumları, görev/süreç yönetimi, yeniden bağlanma.
- [x] MCP `initialize`, `tools/list`, `tools/call`; **ChatGPT/Claude canlı connector kabulü henüz yok.**

## P0 — Desktop Commander temel MCP operasyon eşdeğerliği
- [ ] Büyük dosya/terminal çıktısında sayfalama: pozitif ve sondan negatif satır offset, kapasite sınırları, tail. Gerçek Agent+Gateway uçtan uca test.
- [ ] Çoklu dosya okuma: aynı cihaza 1-10 yollu, kısmi hata desteği, kaynak/kota kontrolü, E2E test.
- [ ] Akışlı arama oturumları: başlat/duraklat/sonuçları sayfalı getir/durdur, eşzamanlı arama; `ripgrep` uygun ise kullan.
- [ ] Process oturumlarında çıktı sayfalama, prompt/REPL belirleme, SIGTERM/tree-cleanup; Windows/macOS/Linux E2E.
- [ ] MCP standardı bağlantı/çağrı kontratına göre gerçek ChatGPT ve Claude kullanım kabulü; schema uyuşmazlıklarını gider.
- [ ] Cihaz eşleştirme, yeniden bağlanma, reboot, paket yükseltme, uninstall ve cihaz iptali: üç OS üzerinde fiziksel kabul.
- [ ] Güvenli dosya işleminde atomik düzenleme, çakışma beklentisi/rollback ve büyük dizin E2E.
- [ ] Konfigürasyon okuma/güncelleme: sınırlı dizinler, güvenli shell seçimi, engelli komutlar, yetkilendirme ve audit.
- [ ] Araç geçmişi ve işlemlerin çıktı özetlerine güvenli sayfalı erişim.

## P1 — Belge ve özel format eşdeğerliği
- [ ] Excel `.xlsx/.xlsm`: çalışma kitabı/sekme/alan okuma, hücre aralığı düzenleme, biçimi koruma, arama.
- [ ] DOCX: paragraf/tablo okuma, yapılandırılmış değişiklik, orijinal biçimi koruyan atomik kaydetme.
- [ ] PDF: sayfa/metin okuma, sayfa bazlı ekle/çıkar/birleştir ve özgün dosyaya zarar vermeyen güvenli çıktı.
- [ ] Görsel önizleme; güvenli format/metaveri görüntüleme.
- [ ] CSV/JSON/Markdown ve kod dosyaları için güçlü araçlar; çift yönlü içerik akışı.
- [ ] Performans regresyonları: büyük belge, eşzamanlı görev, bellek/CPU ve içerik kaybı testleri.

## P2 — Kullanıcı deneyimi ve dağıtım paritesi
- [ ] Tüm işlem türleri için çalışan okunabilir web ekranları, terminal, dosya ve arama sonuçları.
- [ ] Masaüstü/terminal paketlerinde kararlı yükleme, güncelleme ve kaldırma.
- [ ] macOS Developer ID + noter onayı (harici imza materyali gerektirir), Windows imzalama ve SmartScreen kabulü.
- [ ] Hata mesajları, yardım, araç kategorileri, hızlı başlangıç; dosya yüklemeden/çıkarma yapmadan bağlanma.
- [ ] Kontrat tabanlı tool matrisi: araç adı, parametre, dönüş, hata, kota, güvenlik, OS testleri.

## Kabul kapısı
Her özellik için: (1) GitHub `main` CI PASS, (2) gerçek Agent ↔ Gateway E2E, (3) Windows+Ubuntu+macOS cihaz kabulü (mümkün olan yerde), (4) risk/izin denetimi, (5) sürüm ve kurulum uyumu, (6) fiilî ChatGPT veya Claude istemci testi. CI başarısı tek başına production kabul değildir.

**Farklılaştırma:** Parite kabulünden sonra ayrı faz olarak ele alınacak; mevcut SaaS/gateway mimarisi korunur, kapsam şişirilmez.
