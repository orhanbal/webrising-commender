# WECOMMANDER v1.0 kabul testi (yaklaşık 30 dakika)

Her satırı dene; sorun varsa satır numarasını ve bir ekran görüntüsünü gönder.
"Tamam" yazman yeterli. Hata mesajı görürsen metnini olduğu gibi yaz.

## Windows (yaklaşık 15 dk)

**Kurulum ve giriş**
1. Uygulamayı güncelle ya da siteden yeniden kur. Açılınca bir kez "Yenilikler" kartı çıkıyor mu?
2. Tepsi ikonundan ana pencere açılıyor mu? Hesabın ve bu bilgisayar "çevrimiçi" görünüyor mu?

**Dock**
3. Dock modunda Dock ekranın kenarında, açık ve koyu temada **hiç kenar çizgisi olmadan** duruyor mu?
4. Dock'u yavaşça başka bir kenara sürükle: yeni kenarda kalıyor mu, geri zıplamıyor mu? Ekranın ortasına bırakınca yüzüyor mu?
5. Sağ tık → "Dock'u kilitle": kilitliyken sürüklenmiyor mu?
6. WECOMMANDER ikonu, Görev Yöneticisi, Görevler, Terminal, bildirimler ve ayarlar: her biri Dock'tan panel olarak açılıp kapanıyor mu?
7. Tepsi menüsünden "Klasik mod"a geç: Dock kayboluyor ve ekran alanı geri geliyor mu? Sonra "Dock modu"na dön.

**SSH istemcisi**
8. Bir sunucu ekle (ya da ~/.ssh/config'ten içe aktar) ve bağlan: terminal çalışıyor mu?
9. İkinci sekme aç, ekranı böl: iki terminal de çalışıyor mu?
10. SFTP: bir dosyayı sürükleyip sunucuya bırak, sonra geri indir.
11. Sunucu yönetimi: disk özeti açılıyor mu? "Temizlenebilir" listesi geliyor mu? Temizlik yapmak zorunda değilsin, yalnızca listeyi gör.

**Yapay zekâ ve onay**
12. Claude ya da ChatGPT'den bu bilgisayarda bir komut çalıştırmasını iste: Windows'ta onay bildirimi geliyor mu? "Reddet" de: yapay zekâ reddedildiğini görüyor mu?
13. Aynı isteği tekrarla ve "Onayla" de: komut çalışıyor mu? Web panelindeki denetim kaydında görünüyor mu?
14. (İsteğe bağlı) Hibrit Erişim: sunucu ayarlarından bir SSH sunucusunu yapay zekâya aç, yapay zekâdan o sunucunun disk durumunu iste.

## Mac (yaklaşık 10 dk)

15. Terminal'den kurulum komutuyla kur (`curl -fsSL https://wecommander.app/install.sh | sh`): "Apple doğrulayamadı" uyarısı **çıkmıyor** mu?
16. Ana pencerede başlıklar düzgün mü? Bağlı sunucu listede görünüyor mu? (Bilinen hata: ekran görüntüsü gönder.)
17. Bir sunucuya bağlan, terminal ve SFTP çalışıyor mu?
18. Menü çubuğunda canlı sunucu izleme görünüyor mu?
19. Yapay zekâ onayı: Mac'te onay bildirimi geliyor mu? Onay ve ret çalışıyor mu?

## Site ve hesap (yaklaşık 5 dk)

20. wecommander.app: landing sayfası, Paketler, Yenilikler ve Sık sorulanlar açılıyor mu? Dil değiştirince sayfa çevriliyor mu?
21. Çıkış yap → "Şifremi unuttum" → e-posta geliyor mu, yeni şifreyle giriş yapılıyor mu?
22. **Satın alma testi:** Pro'yu gerçek kartla satın al → hesabında Pro görünüyor mu? Ardından aboneliği iptal et; gerekirse iade iste. (Doğrulamayı ben Paddle'dan yapacağım.)
