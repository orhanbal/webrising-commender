// SSH servers for remote AI (Hybrid Access, Linux): which saved SSH hosts
// ChatGPT / Claude.ai may use through this computer, with their preset and
// sudo setting, and the connector's status. The SSH keys and passwords stay
// in this app's core; this page only sees names, addresses and switches.
(() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  // Turkish is the source text (as in the rest of this window); the other
  // languages of the WECOMMANDER apps follow the system language.
  const I18N = {
    en: {
      "SSH sunucuları": "SSH servers",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai) paylaştığın SSH sunucularını bu bilgisayar üzerinden kullanabilir. Sunucuya hiçbir şey kurulmaz; SSH anahtarın ve parolan bu bilgisayardan çıkmaz. Sen açmadıkça hiçbir yapay zekâ bir sunucuyu göremez.": "Remote AIs (ChatGPT web and mobile, Claude.ai) can use the SSH servers you share, through this computer. Nothing is installed on the server; your SSH key and password never leave this computer. No AI can see a server unless you turn it on.",
      "Bağlayıcı çevrimiçi": "Connector online",
      "Bağlayıcı çevrimdışı": "Connector offline",
      "Bağlayıcı kapalı: önce oturum aç.": "Connector off: sign in first.",
      "Bağlayıcı başlıyor…": "Connector starting…",
      "{n} sunucu paylaşılıyor": "{n} servers shared",
      "{n} işlem çalışıyor": "{n} calls running",
      "Bu bilgisayar kapalıyken ya da uygulama açık değilken uzak yapay zekâ bu sunuculara ulaşamaz.": "While this computer is off or the app is not running, remote AI cannot reach these servers.",
      "Oturum geçersiz; yeniden oturum aç.": "The session is no longer valid; sign in again.",
      "wecommander.app'e ulaşılamıyor; yeniden denenecek.": "wecommander.app cannot be reached; trying again.",
      "~/.ssh/config'den içe aktar": "Import from ~/.ssh/config",
      "Sunucu ekle": "Add server",
      "Ekle": "Add",
      "Vazgeç": "Cancel",
      "Sil": "Delete",
      "Evet, sil": "Yes, delete",
      "Bu sunucu silinsin mi? Kayıtlı parolası da silinir.": "Delete this server? Its saved password is deleted too.",
      "Ad": "Name",
      "Adres": "Address",
      "Port": "Port",
      "Kullanıcı": "User",
      "SSH anahtarı": "SSH key",
      "Parola": "Password",
      "Henüz kayıtlı SSH sunucusu yok. ~/.ssh/config'den içe aktar ya da sunucu ekle.": "No saved SSH servers yet. Import from ~/.ssh/config or add a server.",
      "{a} sunucu eklendi, {s} zaten kayıtlıydı.": "{a} servers added, {s} were already saved.",
      "Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.": "First connect once and confirm the server's identity. The AI cannot connect to a server whose identity (host key) is not verified.",
      "Kayıtlı parola ya da anahtar yok: yapay zekâ sorusuz giriş yapamaz. Bir kez parolanla bağlan; parola anahtar zincirine kaydedilir.": "No saved password or key: the AI cannot log in without asking. Connect once with your password; it is saved in the keyring.",
      "Yapay zekâ erişimi yalnız SSH sunucularında çalışır.": "AI access works only on SSH servers.",
      "Bağlan ve doğrula": "Connect and verify",
      "Parola (gerekiyorsa)": "Password (if needed)",
      "İlk bağlantı: bu parmak izini sunucununkiyle karşılaştır; yalnız tanıyorsan güven.": "First connection: compare this fingerprint with the server's; trust it only if you recognise it.",
      "Bu anahtara güven": "Trust this key",
      "Sunucunun kimliği değişmiş! Bu bir saldırı olabilir; sunucuyu kontrol etmeden devam etme.": "The server's identity has changed! This may be an attack; do not continue before checking the server.",
      "Bağlantı başarılı.": "Connected successfully.",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)": "Remote AIs (ChatGPT web and mobile, Claude.ai)",
      "Paylaşılıyor": "Shared",
      "Yalnız elle": "Manual only",
      "Başka bir bilgisayar üzerinden paylaşılıyor.": "Shared through another computer.",
      "Salt okunur": "Read only",
      "Onaylı (önerilen)": "With approval (recommended)",
      "Dosyaları okur, klasörleri listeler, sunucunun durumuna bakar. Komut çalıştıramaz, dosya yazamaz.": "Reads files, lists folders and checks the server's state. Cannot run commands or write files.",
      "Her komut ve dosya değişikliği, tam komutu gösteren tek kullanımlık onayla çalışır (Onaylar sekmesi, bildirim ya da web).": "Every command and file change runs only after a one-time approval that shows the exact command (Approvals tab, notification or web).",
      "Sudo: asla": "Sudo: never",
      "Sudo: sunucudaki sudoers izinleri": "Sudo: the server's sudoers rules",
      "SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.": "Folder limits cannot be enforced for commands run over SSH: a command can reach everything the user you connect as can reach. For tighter limits, install the agent on this server or use a separate SSH user with only the permissions needed.",
      "Onay ekranı her zaman tam komutu gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır · Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.": "The approval always shows the exact command · Passwords, keys and tokens in the output are masked · Every action is written to the audit log · The AI cannot connect before the server's identity (host key) is verified.",
      "Anahtar zinciri (Secret Service) bulunamadı: parolalar yalnız uygulama açıkken hatırlanır. Anahtar dosyası ya da SSH ajanı kullan.": "No keyring (Secret Service) found: passwords are remembered only while the app runs. Use a key file or the SSH agent.",
      "Önce oturum aç.": "Sign in first.",
      "Yapay zekâya root izni ver (bu sunucuda)": "Give AI root permission (on this server)",
      "Root iznini kaldır": "Remove root permission",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.": "A new terminal opens on this server and runs the command below. It writes a sudoers file that gives the WECOMMANDER agent's service user sudo (/etc/sudoers.d/wecommander-agent) and relaxes the service restrictions that block sudo. If the agent isn't installed, it installs it first.",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.": "A new terminal opens on this server and runs the command below. It deletes the agent's sudoers file and restores the service restrictions. AI can then no longer run as root on this device.",
      "sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.": "You type your sudo password in the terminal yourself; WECOMMANDER doesn't see or store it.",
      "Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.": "This is only the first key: root stays off until an admin turns it on in the web panel with their password. To undo: right-click the server → Remove root permission.",
      "Çalışacak komut": "Command to run",
      "Terminalde çalıştır": "Run in terminal",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.": "The command is running in the terminal; type your sudo password there. When it's done, the second key: an admin turns root on in the web panel.",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner.": "The command is running in the terminal; type your sudo password there. When it's done, the agent reconnects and the device goes back to running as the user.",
      "Web'de yetkileri aç": "Open permissions on the web",
      "Bitti. Kapatmak için Enter'a bas.": "Done. Press Enter to close.",
      "Terminal bulunamadı: gnome-terminal, konsole, xfce4-terminal ya da xterm kur.": "No terminal found: install gnome-terminal, konsole, xfce4-terminal or xterm.",
      "Bu bilgisayarın terminali açılır ve ssh ile bu sunucuya bağlanır; SSH girişini ve sudo parolanı orada kendin yaparsın.": "This computer's terminal opens and connects to this server with ssh; you log in and type your sudo password there yourself.",
    },
    de: {
      "SSH sunucuları": "SSH-Server",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai) paylaştığın SSH sunucularını bu bilgisayar üzerinden kullanabilir. Sunucuya hiçbir şey kurulmaz; SSH anahtarın ve parolan bu bilgisayardan çıkmaz. Sen açmadıkça hiçbir yapay zekâ bir sunucuyu göremez.": "Entfernte KIs (ChatGPT Web und Mobil, Claude.ai) können die SSH-Server, die du freigibst, über diesen Computer nutzen. Auf dem Server wird nichts installiert; dein SSH-Schlüssel und dein Passwort verlassen diesen Computer nie. Keine KI sieht einen Server, solange du ihn nicht freigibst.",
      "Bağlayıcı çevrimiçi": "Connector online",
      "Bağlayıcı çevrimdışı": "Connector offline",
      "Bağlayıcı kapalı: önce oturum aç.": "Connector aus: zuerst anmelden.",
      "Bağlayıcı başlıyor…": "Connector startet…",
      "{n} sunucu paylaşılıyor": "{n} Server freigegeben",
      "{n} işlem çalışıyor": "{n} Aufrufe laufen",
      "Bu bilgisayar kapalıyken ya da uygulama açık değilken uzak yapay zekâ bu sunuculara ulaşamaz.": "Solange dieser Computer aus ist oder die App nicht läuft, erreicht die entfernte KI diese Server nicht.",
      "Oturum geçersiz; yeniden oturum aç.": "Die Sitzung ist nicht mehr gültig; melde dich erneut an.",
      "wecommander.app'e ulaşılamıyor; yeniden denenecek.": "wecommander.app ist nicht erreichbar; neuer Versuch folgt.",
      "~/.ssh/config'den içe aktar": "Aus ~/.ssh/config importieren",
      "Sunucu ekle": "Server hinzufügen",
      "Ekle": "Hinzufügen",
      "Vazgeç": "Abbrechen",
      "Sil": "Löschen",
      "Evet, sil": "Ja, löschen",
      "Bu sunucu silinsin mi? Kayıtlı parolası da silinir.": "Diesen Server löschen? Sein gespeichertes Passwort wird ebenfalls gelöscht.",
      "Ad": "Name",
      "Adres": "Adresse",
      "Port": "Port",
      "Kullanıcı": "Benutzer",
      "SSH anahtarı": "SSH-Schlüssel",
      "Parola": "Passwort",
      "Henüz kayıtlı SSH sunucusu yok. ~/.ssh/config'den içe aktar ya da sunucu ekle.": "Noch keine gespeicherten SSH-Server. Importiere aus ~/.ssh/config oder füge einen Server hinzu.",
      "{a} sunucu eklendi, {s} zaten kayıtlıydı.": "{a} Server hinzugefügt, {s} waren schon gespeichert.",
      "Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.": "Verbinde dich zuerst einmal und bestätige die Identität des Servers. Die KI kann sich nicht mit einem Server verbinden, dessen Identität (Host-Key) nicht bestätigt ist.",
      "Kayıtlı parola ya da anahtar yok: yapay zekâ sorusuz giriş yapamaz. Bir kez parolanla bağlan; parola anahtar zincirine kaydedilir.": "Kein gespeichertes Passwort oder Schlüssel: Die KI kann sich nicht ohne Nachfrage anmelden. Verbinde dich einmal mit deinem Passwort; es wird im Schlüsselbund gespeichert.",
      "Yapay zekâ erişimi yalnız SSH sunucularında çalışır.": "KI-Zugriff funktioniert nur auf SSH-Servern.",
      "Bağlan ve doğrula": "Verbinden und prüfen",
      "Parola (gerekiyorsa)": "Passwort (falls nötig)",
      "İlk bağlantı: bu parmak izini sunucununkiyle karşılaştır; yalnız tanıyorsan güven.": "Erste Verbindung: Vergleiche diesen Fingerabdruck mit dem des Servers; vertraue ihm nur, wenn du ihn erkennst.",
      "Bu anahtara güven": "Diesem Schlüssel vertrauen",
      "Sunucunun kimliği değişmiş! Bu bir saldırı olabilir; sunucuyu kontrol etmeden devam etme.": "Die Identität des Servers hat sich geändert! Das kann ein Angriff sein; fahre nicht fort, bevor du den Server geprüft hast.",
      "Bağlantı başarılı.": "Verbindung erfolgreich.",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)": "Entfernte KIs (ChatGPT Web und Mobil, Claude.ai)",
      "Paylaşılıyor": "Freigegeben",
      "Yalnız elle": "Nur manuell",
      "Başka bir bilgisayar üzerinden paylaşılıyor.": "Über einen anderen Computer freigegeben.",
      "Salt okunur": "Nur lesen",
      "Onaylı (önerilen)": "Mit Bestätigung (empfohlen)",
      "Dosyaları okur, klasörleri listeler, sunucunun durumuna bakar. Komut çalıştıramaz, dosya yazamaz.": "Liest Dateien, listet Ordner und prüft den Zustand des Servers. Kann keine Befehle ausführen und keine Dateien schreiben.",
      "Her komut ve dosya değişikliği, tam komutu gösteren tek kullanımlık onayla çalışır (Onaylar sekmesi, bildirim ya da web).": "Jeder Befehl und jede Dateiänderung läuft erst nach einer einmaligen Bestätigung, die den genauen Befehl zeigt (Tab Bestätigungen, Benachrichtigung oder Web).",
      "Sudo: asla": "Sudo: nie",
      "Sudo: sunucudaki sudoers izinleri": "Sudo: sudoers-Regeln des Servers",
      "SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.": "Ordnergrenzen lassen sich bei über SSH ausgeführten Befehlen nicht durchsetzen: Ein Befehl erreicht alles, was der verbundene Benutzer erreicht. Für engere Grenzen installiere den Agenten auf diesem Server oder nutze einen eigenen SSH-Benutzer mit nur den nötigen Rechten.",
      "Onay ekranı her zaman tam komutu gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır · Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.": "Die Bestätigung zeigt immer den genauen Befehl · Passwörter, Schlüssel und Tokens in der Ausgabe werden maskiert · Jede Aktion landet im Audit-Log · Ohne bestätigte Server-Identität (Host-Key) verbindet sich die KI nicht.",
      "Anahtar zinciri (Secret Service) bulunamadı: parolalar yalnız uygulama açıkken hatırlanır. Anahtar dosyası ya da SSH ajanı kullan.": "Kein Schlüsselbund (Secret Service) gefunden: Passwörter bleiben nur gespeichert, solange die App läuft. Nutze eine Schlüsseldatei oder den SSH-Agenten.",
      "Önce oturum aç.": "Zuerst anmelden.",
      "Yapay zekâya root izni ver (bu sunucuda)": "KI Root-Rechte geben (auf diesem Server)",
      "Root iznini kaldır": "Root-Rechte entfernen",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.": "Auf diesem Server öffnet sich ein neues Terminal und führt den Befehl unten aus. Er schreibt eine sudoers-Datei, die dem Dienstbenutzer des WECOMMANDER-Agenten sudo erlaubt (/etc/sudoers.d/wecommander-agent), und lockert die Dienst-Einschränkungen, die sudo blockieren. Ist der Agent nicht installiert, wird er zuerst installiert.",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.": "Auf diesem Server öffnet sich ein neues Terminal und führt den Befehl unten aus. Er löscht die sudoers-Datei des Agenten und stellt die Dienst-Einschränkungen wieder her. Die KI kann auf diesem Gerät dann nicht mehr als root arbeiten.",
      "sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.": "Dein sudo-Passwort tippst du selbst im Terminal ein; WECOMMANDER sieht und speichert es nicht.",
      "Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.": "Das ist nur der erste Schlüssel: Root bleibt aus, bis ein Admin es im Webpanel mit seinem Passwort einschaltet. Rückgängig machen: Rechtsklick auf den Server → Root-Rechte entfernen.",
      "Çalışacak komut": "Auszuführender Befehl",
      "Terminalde çalıştır": "Im Terminal ausführen",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.": "Der Befehl läuft im Terminal; gib dort dein sudo-Passwort ein. Danach der zweite Schlüssel: Ein Admin schaltet Root im Webpanel ein.",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner.": "Der Befehl läuft im Terminal; gib dort dein sudo-Passwort ein. Danach verbindet sich der Agent neu und das Gerät arbeitet wieder als Benutzer.",
      "Web'de yetkileri aç": "Berechtigungen im Web öffnen",
      "Bitti. Kapatmak için Enter'a bas.": "Fertig. Zum Schließen Enter drücken.",
      "Terminal bulunamadı: gnome-terminal, konsole, xfce4-terminal ya da xterm kur.": "Kein Terminal gefunden: Installiere gnome-terminal, konsole, xfce4-terminal oder xterm.",
      "Bu bilgisayarın terminali açılır ve ssh ile bu sunucuya bağlanır; SSH girişini ve sudo parolanı orada kendin yaparsın.": "Das Terminal dieses Computers öffnet sich und verbindet sich per ssh mit diesem Server; Anmeldung und sudo-Passwort gibst du dort selbst ein.",
    },
    "pt-BR": {
      "SSH sunucuları": "Servidores SSH",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai) paylaştığın SSH sunucularını bu bilgisayar üzerinden kullanabilir. Sunucuya hiçbir şey kurulmaz; SSH anahtarın ve parolan bu bilgisayardan çıkmaz. Sen açmadıkça hiçbir yapay zekâ bir sunucuyu göremez.": "IAs remotas (ChatGPT web e celular, Claude.ai) podem usar os servidores SSH que você compartilhar, por meio deste computador. Nada é instalado no servidor; sua chave SSH e sua senha nunca saem deste computador. Nenhuma IA vê um servidor até você ativá-lo.",
      "Bağlayıcı çevrimiçi": "Conector online",
      "Bağlayıcı çevrimdışı": "Conector offline",
      "Bağlayıcı kapalı: önce oturum aç.": "Conector desligado: entre primeiro.",
      "Bağlayıcı başlıyor…": "Conector iniciando…",
      "{n} sunucu paylaşılıyor": "{n} servidores compartilhados",
      "{n} işlem çalışıyor": "{n} chamadas em execução",
      "Bu bilgisayar kapalıyken ya da uygulama açık değilken uzak yapay zekâ bu sunuculara ulaşamaz.": "Com este computador desligado ou o app fechado, a IA remota não alcança esses servidores.",
      "Oturum geçersiz; yeniden oturum aç.": "A sessão não é mais válida; entre novamente.",
      "wecommander.app'e ulaşılamıyor; yeniden denenecek.": "Não foi possível alcançar wecommander.app; tentando de novo.",
      "~/.ssh/config'den içe aktar": "Importar de ~/.ssh/config",
      "Sunucu ekle": "Adicionar servidor",
      "Ekle": "Adicionar",
      "Vazgeç": "Cancelar",
      "Sil": "Excluir",
      "Evet, sil": "Sim, excluir",
      "Bu sunucu silinsin mi? Kayıtlı parolası da silinir.": "Excluir este servidor? A senha salva também é excluída.",
      "Ad": "Nome",
      "Adres": "Endereço",
      "Port": "Porta",
      "Kullanıcı": "Usuário",
      "SSH anahtarı": "Chave SSH",
      "Parola": "Senha",
      "Henüz kayıtlı SSH sunucusu yok. ~/.ssh/config'den içe aktar ya da sunucu ekle.": "Nenhum servidor SSH salvo ainda. Importe de ~/.ssh/config ou adicione um servidor.",
      "{a} sunucu eklendi, {s} zaten kayıtlıydı.": "{a} servidores adicionados, {s} já estavam salvos.",
      "Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.": "Conecte uma vez e confirme a identidade do servidor. A IA não pode se conectar a um servidor cuja identidade (host key) não foi verificada.",
      "Kayıtlı parola ya da anahtar yok: yapay zekâ sorusuz giriş yapamaz. Bir kez parolanla bağlan; parola anahtar zincirine kaydedilir.": "Nenhuma senha ou chave salva: a IA não consegue entrar sem perguntar. Conecte uma vez com sua senha; ela é salva no chaveiro.",
      "Yapay zekâ erişimi yalnız SSH sunucularında çalışır.": "O acesso de IA funciona só em servidores SSH.",
      "Bağlan ve doğrula": "Conectar e verificar",
      "Parola (gerekiyorsa)": "Senha (se necessário)",
      "İlk bağlantı: bu parmak izini sunucununkiyle karşılaştır; yalnız tanıyorsan güven.": "Primeira conexão: compare esta impressão digital com a do servidor; confie só se você a reconhecer.",
      "Bu anahtara güven": "Confiar nesta chave",
      "Sunucunun kimliği değişmiş! Bu bir saldırı olabilir; sunucuyu kontrol etmeden devam etme.": "A identidade do servidor mudou! Pode ser um ataque; não continue antes de verificar o servidor.",
      "Bağlantı başarılı.": "Conectado com sucesso.",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)": "IAs remotas (ChatGPT web e celular, Claude.ai)",
      "Paylaşılıyor": "Compartilhado",
      "Yalnız elle": "Só manual",
      "Başka bir bilgisayar üzerinden paylaşılıyor.": "Compartilhado por outro computador.",
      "Salt okunur": "Somente leitura",
      "Onaylı (önerilen)": "Com aprovação (recomendado)",
      "Dosyaları okur, klasörleri listeler, sunucunun durumuna bakar. Komut çalıştıramaz, dosya yazamaz.": "Lê arquivos, lista pastas e verifica o estado do servidor. Não pode executar comandos nem gravar arquivos.",
      "Her komut ve dosya değişikliği, tam komutu gösteren tek kullanımlık onayla çalışır (Onaylar sekmesi, bildirim ya da web).": "Cada comando e alteração de arquivo só roda após uma aprovação única que mostra o comando exato (aba Aprovações, notificação ou web).",
      "Sudo: asla": "Sudo: nunca",
      "Sudo: sunucudaki sudoers izinleri": "Sudo: regras sudoers do servidor",
      "SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.": "Limites de pasta não podem ser aplicados a comandos executados via SSH: um comando alcança tudo o que o usuário conectado alcança. Para limites mais rígidos, instale o agente neste servidor ou use um usuário SSH separado só com as permissões necessárias.",
      "Onay ekranı her zaman tam komutu gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır · Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.": "A aprovação sempre mostra o comando exato · Senhas, chaves e tokens na saída são mascarados · Toda ação vai para o log de auditoria · A IA não se conecta antes de a identidade do servidor (host key) ser verificada.",
      "Anahtar zinciri (Secret Service) bulunamadı: parolalar yalnız uygulama açıkken hatırlanır. Anahtar dosyası ya da SSH ajanı kullan.": "Nenhum chaveiro (Secret Service) encontrado: as senhas só ficam salvas enquanto o app está aberto. Use um arquivo de chave ou o agente SSH.",
      "Önce oturum aç.": "Entre primeiro.",
      "Yapay zekâya root izni ver (bu sunucuda)": "Dar permissão root à IA (neste servidor)",
      "Root iznini kaldır": "Remover permissão root",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.": "Um novo terminal abre neste servidor e executa o comando abaixo. Ele grava um arquivo sudoers que dá sudo ao usuário de serviço do agente WECOMMANDER (/etc/sudoers.d/wecommander-agent) e relaxa as restrições do serviço que bloqueiam o sudo. Se o agente não estiver instalado, ele o instala primeiro.",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.": "Um novo terminal abre neste servidor e executa o comando abaixo. Ele apaga o arquivo sudoers do agente e restaura as restrições do serviço. A IA não poderá mais rodar como root neste dispositivo.",
      "sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.": "Você mesmo digita sua senha do sudo no terminal; o WECOMMANDER não a vê nem a guarda.",
      "Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.": "Esta é só a primeira chave: o root continua desligado até um administrador ativá-lo no painel web com a senha dele. Para desfazer: clique com o botão direito no servidor → Remover permissão root.",
      "Çalışacak komut": "Comando a executar",
      "Terminalde çalıştır": "Executar no terminal",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.": "O comando está rodando no terminal; digite sua senha do sudo lá. Quando terminar, a segunda chave: um administrador ativa o root no painel web.",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner.": "O comando está rodando no terminal; digite sua senha do sudo lá. Quando terminar, o agente se reconecta e o dispositivo volta a rodar como usuário.",
      "Web'de yetkileri aç": "Abrir permissões na web",
      "Bitti. Kapatmak için Enter'a bas.": "Pronto. Pressione Enter para fechar.",
      "Terminal bulunamadı: gnome-terminal, konsole, xfce4-terminal ya da xterm kur.": "Nenhum terminal encontrado: instale gnome-terminal, konsole, xfce4-terminal ou xterm.",
      "Bu bilgisayarın terminali açılır ve ssh ile bu sunucuya bağlanır; SSH girişini ve sudo parolanı orada kendin yaparsın.": "O terminal deste computador abre e se conecta a este servidor com ssh; você mesmo faz o login e digita sua senha do sudo lá.",
    },
    es: {
      "SSH sunucuları": "Servidores SSH",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai) paylaştığın SSH sunucularını bu bilgisayar üzerinden kullanabilir. Sunucuya hiçbir şey kurulmaz; SSH anahtarın ve parolan bu bilgisayardan çıkmaz. Sen açmadıkça hiçbir yapay zekâ bir sunucuyu göremez.": "Las IA remotas (ChatGPT web y móvil, Claude.ai) pueden usar los servidores SSH que compartas, a través de este equipo. No se instala nada en el servidor; tu clave SSH y tu contraseña nunca salen de este equipo. Ninguna IA ve un servidor hasta que tú lo actives.",
      "Bağlayıcı çevrimiçi": "Conector en línea",
      "Bağlayıcı çevrimdışı": "Conector sin conexión",
      "Bağlayıcı kapalı: önce oturum aç.": "Conector apagado: inicia sesión primero.",
      "Bağlayıcı başlıyor…": "Conector iniciándose…",
      "{n} sunucu paylaşılıyor": "{n} servidores compartidos",
      "{n} işlem çalışıyor": "{n} llamadas en curso",
      "Bu bilgisayar kapalıyken ya da uygulama açık değilken uzak yapay zekâ bu sunuculara ulaşamaz.": "Mientras este equipo esté apagado o la app cerrada, la IA remota no puede llegar a estos servidores.",
      "Oturum geçersiz; yeniden oturum aç.": "La sesión ya no es válida; vuelve a iniciar sesión.",
      "wecommander.app'e ulaşılamıyor; yeniden denenecek.": "No se puede llegar a wecommander.app; se volverá a intentar.",
      "~/.ssh/config'den içe aktar": "Importar de ~/.ssh/config",
      "Sunucu ekle": "Añadir servidor",
      "Ekle": "Añadir",
      "Vazgeç": "Cancelar",
      "Sil": "Eliminar",
      "Evet, sil": "Sí, eliminar",
      "Bu sunucu silinsin mi? Kayıtlı parolası da silinir.": "¿Eliminar este servidor? Su contraseña guardada también se elimina.",
      "Ad": "Nombre",
      "Adres": "Dirección",
      "Port": "Puerto",
      "Kullanıcı": "Usuario",
      "SSH anahtarı": "Clave SSH",
      "Parola": "Contraseña",
      "Henüz kayıtlı SSH sunucusu yok. ~/.ssh/config'den içe aktar ya da sunucu ekle.": "Aún no hay servidores SSH guardados. Importa de ~/.ssh/config o añade un servidor.",
      "{a} sunucu eklendi, {s} zaten kayıtlıydı.": "{a} servidores añadidos, {s} ya estaban guardados.",
      "Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.": "Conéctate una vez y confirma la identidad del servidor. La IA no puede conectarse a un servidor cuya identidad (host key) no esté verificada.",
      "Kayıtlı parola ya da anahtar yok: yapay zekâ sorusuz giriş yapamaz. Bir kez parolanla bağlan; parola anahtar zincirine kaydedilir.": "No hay contraseña ni clave guardada: la IA no puede iniciar sesión sin preguntar. Conéctate una vez con tu contraseña; se guarda en el llavero.",
      "Yapay zekâ erişimi yalnız SSH sunucularında çalışır.": "El acceso de IA solo funciona en servidores SSH.",
      "Bağlan ve doğrula": "Conectar y verificar",
      "Parola (gerekiyorsa)": "Contraseña (si hace falta)",
      "İlk bağlantı: bu parmak izini sunucununkiyle karşılaştır; yalnız tanıyorsan güven.": "Primera conexión: compara esta huella con la del servidor; confía solo si la reconoces.",
      "Bu anahtara güven": "Confiar en esta clave",
      "Sunucunun kimliği değişmiş! Bu bir saldırı olabilir; sunucuyu kontrol etmeden devam etme.": "¡La identidad del servidor ha cambiado! Puede ser un ataque; no continúes sin revisar el servidor.",
      "Bağlantı başarılı.": "Conexión correcta.",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)": "IA remotas (ChatGPT web y móvil, Claude.ai)",
      "Paylaşılıyor": "Compartido",
      "Yalnız elle": "Solo manual",
      "Başka bir bilgisayar üzerinden paylaşılıyor.": "Compartido a través de otro equipo.",
      "Salt okunur": "Solo lectura",
      "Onaylı (önerilen)": "Con aprobación (recomendado)",
      "Dosyaları okur, klasörleri listeler, sunucunun durumuna bakar. Komut çalıştıramaz, dosya yazamaz.": "Lee archivos, lista carpetas y consulta el estado del servidor. No puede ejecutar comandos ni escribir archivos.",
      "Her komut ve dosya değişikliği, tam komutu gösteren tek kullanımlık onayla çalışır (Onaylar sekmesi, bildirim ya da web).": "Cada comando y cambio de archivo se ejecuta solo tras una aprobación única que muestra el comando exacto (pestaña Aprobaciones, notificación o web).",
      "Sudo: asla": "Sudo: nunca",
      "Sudo: sunucudaki sudoers izinleri": "Sudo: reglas sudoers del servidor",
      "SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.": "Los límites de carpeta no se pueden aplicar a comandos ejecutados por SSH: un comando llega a todo lo que puede el usuario con el que te conectas. Para límites más estrictos, instala el agente en este servidor o usa un usuario SSH aparte solo con los permisos necesarios.",
      "Onay ekranı her zaman tam komutu gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır · Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.": "La aprobación siempre muestra el comando exacto · Las contraseñas, claves y tokens de la salida se enmascaran · Cada acción queda en el registro de auditoría · La IA no se conecta sin verificar la identidad del servidor (host key).",
      "Anahtar zinciri (Secret Service) bulunamadı: parolalar yalnız uygulama açıkken hatırlanır. Anahtar dosyası ya da SSH ajanı kullan.": "No se encontró llavero (Secret Service): las contraseñas solo se recuerdan mientras la app está abierta. Usa un archivo de clave o el agente SSH.",
      "Önce oturum aç.": "Inicia sesión primero.",
      "Yapay zekâya root izni ver (bu sunucuda)": "Dar permiso root a la IA (en este servidor)",
      "Root iznini kaldır": "Quitar el permiso root",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.": "Se abre un terminal nuevo en este servidor y ejecuta el comando de abajo. Escribe un archivo sudoers que da sudo al usuario de servicio del agente de WECOMMANDER (/etc/sudoers.d/wecommander-agent) y relaja las restricciones del servicio que bloquean sudo. Si el agente no está instalado, primero lo instala.",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.": "Se abre un terminal nuevo en este servidor y ejecuta el comando de abajo. Borra el archivo sudoers del agente y restaura las restricciones del servicio. La IA ya no podrá ejecutarse como root en este dispositivo.",
      "sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.": "Escribes tú mismo tu contraseña de sudo en el terminal; WECOMMANDER no la ve ni la guarda.",
      "Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.": "Esta es solo la primera llave: root sigue desactivado hasta que un administrador lo active en el panel web con su contraseña. Para deshacerlo: clic derecho en el servidor → Quitar el permiso root.",
      "Çalışacak komut": "Comando que se ejecutará",
      "Terminalde çalıştır": "Ejecutar en el terminal",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.": "El comando se está ejecutando en el terminal; escribe allí tu contraseña de sudo. Cuando termine, la segunda llave: un administrador activa root en el panel web.",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner.": "El comando se está ejecutando en el terminal; escribe allí tu contraseña de sudo. Cuando termine, el agente se vuelve a conectar y el dispositivo vuelve a ejecutarse como usuario.",
      "Web'de yetkileri aç": "Abrir permisos en la web",
      "Bitti. Kapatmak için Enter'a bas.": "Listo. Pulsa Enter para cerrar.",
      "Terminal bulunamadı: gnome-terminal, konsole, xfce4-terminal ya da xterm kur.": "No se encontró ningún terminal: instala gnome-terminal, konsole, xfce4-terminal o xterm.",
      "Bu bilgisayarın terminali açılır ve ssh ile bu sunucuya bağlanır; SSH girişini ve sudo parolanı orada kendin yaparsın.": "Se abre el terminal de este ordenador y se conecta a este servidor con ssh; tú mismo inicias sesión y escribes tu contraseña de sudo allí.",
    },
    fr: {
      "SSH sunucuları": "Serveurs SSH",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai) paylaştığın SSH sunucularını bu bilgisayar üzerinden kullanabilir. Sunucuya hiçbir şey kurulmaz; SSH anahtarın ve parolan bu bilgisayardan çıkmaz. Sen açmadıkça hiçbir yapay zekâ bir sunucuyu göremez.": "Les IA distantes (ChatGPT web et mobile, Claude.ai) peuvent utiliser les serveurs SSH que tu partages, via cet ordinateur. Rien n'est installé sur le serveur ; ta clé SSH et ton mot de passe ne quittent jamais cet ordinateur. Aucune IA ne voit un serveur tant que tu ne l'as pas activé.",
      "Bağlayıcı çevrimiçi": "Connecteur en ligne",
      "Bağlayıcı çevrimdışı": "Connecteur hors ligne",
      "Bağlayıcı kapalı: önce oturum aç.": "Connecteur arrêté : connecte-toi d'abord.",
      "Bağlayıcı başlıyor…": "Démarrage du connecteur…",
      "{n} sunucu paylaşılıyor": "{n} serveurs partagés",
      "{n} işlem çalışıyor": "{n} appels en cours",
      "Bu bilgisayar kapalıyken ya da uygulama açık değilken uzak yapay zekâ bu sunuculara ulaşamaz.": "Quand cet ordinateur est éteint ou l'app fermée, l'IA distante ne peut pas atteindre ces serveurs.",
      "Oturum geçersiz; yeniden oturum aç.": "La session n'est plus valide ; reconnecte-toi.",
      "wecommander.app'e ulaşılamıyor; yeniden denenecek.": "wecommander.app est injoignable ; nouvel essai bientôt.",
      "~/.ssh/config'den içe aktar": "Importer depuis ~/.ssh/config",
      "Sunucu ekle": "Ajouter un serveur",
      "Ekle": "Ajouter",
      "Vazgeç": "Annuler",
      "Sil": "Supprimer",
      "Evet, sil": "Oui, supprimer",
      "Bu sunucu silinsin mi? Kayıtlı parolası da silinir.": "Supprimer ce serveur ? Son mot de passe enregistré est aussi supprimé.",
      "Ad": "Nom",
      "Adres": "Adresse",
      "Port": "Port",
      "Kullanıcı": "Utilisateur",
      "SSH anahtarı": "Clé SSH",
      "Parola": "Mot de passe",
      "Henüz kayıtlı SSH sunucusu yok. ~/.ssh/config'den içe aktar ya da sunucu ekle.": "Aucun serveur SSH enregistré. Importe depuis ~/.ssh/config ou ajoute un serveur.",
      "{a} sunucu eklendi, {s} zaten kayıtlıydı.": "{a} serveurs ajoutés, {s} étaient déjà enregistrés.",
      "Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.": "Connecte-toi d'abord une fois et confirme l'identité du serveur. L'IA ne peut pas se connecter à un serveur dont l'identité (clé d'hôte) n'est pas vérifiée.",
      "Kayıtlı parola ya da anahtar yok: yapay zekâ sorusuz giriş yapamaz. Bir kez parolanla bağlan; parola anahtar zincirine kaydedilir.": "Aucun mot de passe ni clé enregistré : l'IA ne peut pas se connecter sans demander. Connecte-toi une fois avec ton mot de passe ; il est enregistré dans le trousseau.",
      "Yapay zekâ erişimi yalnız SSH sunucularında çalışır.": "L'accès IA ne fonctionne que sur les serveurs SSH.",
      "Bağlan ve doğrula": "Se connecter et vérifier",
      "Parola (gerekiyorsa)": "Mot de passe (si nécessaire)",
      "İlk bağlantı: bu parmak izini sunucununkiyle karşılaştır; yalnız tanıyorsan güven.": "Première connexion : compare cette empreinte avec celle du serveur ; ne lui fais confiance que si tu la reconnais.",
      "Bu anahtara güven": "Faire confiance à cette clé",
      "Sunucunun kimliği değişmiş! Bu bir saldırı olabilir; sunucuyu kontrol etmeden devam etme.": "L'identité du serveur a changé ! Il peut s'agir d'une attaque ; ne continue pas avant d'avoir vérifié le serveur.",
      "Bağlantı başarılı.": "Connexion réussie.",
      "Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)": "IA distantes (ChatGPT web et mobile, Claude.ai)",
      "Paylaşılıyor": "Partagé",
      "Yalnız elle": "Manuel uniquement",
      "Başka bir bilgisayar üzerinden paylaşılıyor.": "Partagé via un autre ordinateur.",
      "Salt okunur": "Lecture seule",
      "Onaylı (önerilen)": "Avec approbation (recommandé)",
      "Dosyaları okur, klasörleri listeler, sunucunun durumuna bakar. Komut çalıştıramaz, dosya yazamaz.": "Lit les fichiers, liste les dossiers et consulte l'état du serveur. Ne peut ni exécuter de commandes ni écrire de fichiers.",
      "Her komut ve dosya değişikliği, tam komutu gösteren tek kullanımlık onayla çalışır (Onaylar sekmesi, bildirim ya da web).": "Chaque commande et modification de fichier ne s'exécute qu'après une approbation unique qui montre la commande exacte (onglet Approbations, notification ou web).",
      "Sudo: asla": "Sudo : jamais",
      "Sudo: sunucudaki sudoers izinleri": "Sudo : règles sudoers du serveur",
      "SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.": "Les limites de dossier ne peuvent pas s'appliquer aux commandes lancées via SSH : une commande atteint tout ce que l'utilisateur connecté peut atteindre. Pour des limites plus strictes, installe l'agent sur ce serveur ou utilise un utilisateur SSH distinct avec seulement les droits nécessaires.",
      "Onay ekranı her zaman tam komutu gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır · Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.": "L'approbation montre toujours la commande exacte · Les mots de passe, clés et jetons de la sortie sont masqués · Chaque action est inscrite au journal d'audit · L'IA ne se connecte pas tant que l'identité du serveur (clé d'hôte) n'est pas vérifiée.",
      "Anahtar zinciri (Secret Service) bulunamadı: parolalar yalnız uygulama açıkken hatırlanır. Anahtar dosyası ya da SSH ajanı kullan.": "Aucun trousseau (Secret Service) trouvé : les mots de passe ne sont retenus que tant que l'app tourne. Utilise un fichier de clé ou l'agent SSH.",
      "Önce oturum aç.": "Connecte-toi d'abord.",
      "Yapay zekâya root izni ver (bu sunucuda)": "Donner l'autorisation root à l'IA (sur ce serveur)",
      "Root iznini kaldır": "Retirer l'autorisation root",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.": "Un nouveau terminal s'ouvre sur ce serveur et exécute la commande ci-dessous. Elle écrit un fichier sudoers qui donne sudo à l'utilisateur de service de l'agent WECOMMANDER (/etc/sudoers.d/wecommander-agent) et assouplit les restrictions du service qui bloquent sudo. Si l'agent n'est pas installé, elle l'installe d'abord.",
      "Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.": "Un nouveau terminal s'ouvre sur ce serveur et exécute la commande ci-dessous. Elle supprime le fichier sudoers de l'agent et rétablit les restrictions du service. L'IA ne peut alors plus s'exécuter en root sur cet appareil.",
      "sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.": "Vous tapez vous-même votre mot de passe sudo dans le terminal ; WECOMMANDER ne le voit pas et ne l'enregistre pas.",
      "Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.": "Ce n'est que la première clé : root reste désactivé jusqu'à ce qu'un administrateur l'active dans le panneau web avec son mot de passe. Pour annuler : clic droit sur le serveur → Retirer l'autorisation root.",
      "Çalışacak komut": "Commande exécutée",
      "Terminalde çalıştır": "Exécuter dans le terminal",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.": "La commande s'exécute dans le terminal ; tapez-y votre mot de passe sudo. Ensuite, la deuxième clé : un administrateur active root dans le panneau web.",
      "Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner.": "La commande s'exécute dans le terminal ; tapez-y votre mot de passe sudo. Ensuite, l'agent se reconnecte et l'appareil repasse en utilisateur.",
      "Web'de yetkileri aç": "Ouvrir les autorisations sur le web",
      "Bitti. Kapatmak için Enter'a bas.": "Terminé. Appuyez sur Entrée pour fermer.",
      "Terminal bulunamadı: gnome-terminal, konsole, xfce4-terminal ya da xterm kur.": "Aucun terminal trouvé : installez gnome-terminal, konsole, xfce4-terminal ou xterm.",
      "Bu bilgisayarın terminali açılır ve ssh ile bu sunucuya bağlanır; SSH girişini ve sudo parolanı orada kendin yaparsın.": "Le terminal de cet ordinateur s'ouvre et se connecte à ce serveur avec ssh ; vous vous y connectez et tapez vous-même votre mot de passe sudo.",
    },
  };

  function language() {
    for (const tag of navigator.languages || [navigator.language || ""]) {
      const lower = String(tag).toLowerCase();
      if (lower.startsWith("pt")) return "pt-BR";
      const head = lower.split(/[-_]/)[0];
      if (head === "tr") return "tr";
      if (I18N[head]) return head;
    }
    return "tr";
  }
  const table = I18N[language()] || {};
  const T = (text, values = {}) =>
    (table[text] || text).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

  const ERRORS = {
    host_key_untrusted: "Önce bir kez bağlanıp sunucunun kimliğini onayla. Yapay zekâ, kimliği (host key) doğrulanmamış bir sunucuya bağlanamaz.",
    needs_credential: "Kayıtlı parola ya da anahtar yok: yapay zekâ sorusuz giriş yapamaz. Bir kez parolanla bağlan; parola anahtar zincirine kaydedilir.",
    not_ssh: "Yapay zekâ erişimi yalnız SSH sunucularında çalışır.",
    not_signed_in: "Önce oturum aç.",
    no_terminal: "Terminal bulunamadı: gnome-terminal, konsole, xfce4-terminal ya da xterm kur.",
  };

  let view = null;
  let adding = false;
  let deleting = null;
  let verify = {}; // host id -> { fingerprint, changed, message }
  let notice = "";
  let busy = false;
  let timer = null;
  let rootAsk = null; // { id, allow }: the confirmation shown under that host
  let rootDone = null; // { allow, url }: after the terminal opened

  // "Yapay zekâya root izni ver (bu sunucuda)": this computer's terminal
  // opens ssh to the host and runs the fixed command from hybrid.rs; the
  // person logs in and types their sudo password there (docs/AI_PERMISSIONS.md).
  function rootConfirm(host, allow) {
    const command = allow ? view.rootAllowCommand : view.rootDisallowCommand;
    return el("div", { class: "card" },
      el("strong", {}, allow ? T("Yapay zekâya root izni ver (bu sunucuda)") : T("Root iznini kaldır")),
      el("p", { class: "small" }, allow
        ? T("Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.")
        : T("Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz.")),
      el("p", { class: "small muted" }, T("Bu bilgisayarın terminali açılır ve ssh ile bu sunucuya bağlanır; SSH girişini ve sudo parolanı orada kendin yaparsın.")),
      el("p", { class: "small muted" }, T("sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz.")),
      allow ? el("p", { class: "small muted" }, T("Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır.")) : null,
      el("p", { class: "small" }, el("strong", {}, T("Çalışacak komut"))),
      el("code", {}, command),
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: async () => {
          rootAsk = null;
          const result = await run("hybrid_root_terminal", { id: host.id, allow, closeText: T("Bitti. Kapatmak için Enter'a bas.") });
          if (result) rootDone = { allow, url: result.permissionsUrl };
          render();
        } }, T("Terminalde çalıştır")),
        el("button", { class: "ghost", onclick: () => { rootAsk = null; render(); } }, T("Vazgeç"))));
  }

  function rootNotice() {
    return el("div", { class: "card" },
      el("p", { class: "small" }, rootDone.allow
        ? T("Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.")
        : T("Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner.")),
      el("div", { class: "row" },
        rootDone.allow ? el("button", { class: "primary", onclick: () => run("hybrid_open_permissions", { url: rootDone.url }) }, T("Web'de yetkileri aç")) : null,
        el("button", { class: "ghost", onclick: () => { rootDone = null; render(); } }, "×")));
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  function errorText(error) {
    const raw = typeof error === "string" ? error : (error && error.message) || String(error);
    const code = raw.split(":")[0].trim();
    return ERRORS[code] ? T(ERRORS[code]) : raw;
  }

  function showError(error) {
    const box = $("error");
    box.textContent = error ? errorText(error) : "";
    box.hidden = !error;
  }

  async function run(command, args) {
    if (busy) return null;
    busy = true;
    try {
      const result = await invoke(command, args);
      showError("");
      return result;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      busy = false;
    }
  }

  function statusText(s) {
    if (!view.signedIn) return T("Bağlayıcı kapalı: önce oturum aç.");
    const parts = [];
    if (!s.running) parts.push(view.hosts.length ? T("Bağlayıcı başlıyor…") : "");
    else if (s.online) parts.push(T("Bağlayıcı çevrimiçi"));
    else parts.push(T("Bağlayıcı çevrimdışı"));
    if (s.running) parts.push(T("{n} sunucu paylaşılıyor", { n: s.shared }));
    if (s.active) parts.push(T("{n} işlem çalışıyor", { n: s.active }));
    if (s.lastError === "unauthorized") parts.push(T("Oturum geçersiz; yeniden oturum aç."));
    else if (s.lastError === "offline") parts.push(T("wecommander.app'e ulaşılamıyor; yeniden denenecek."));
    return parts.filter(Boolean).join(" · ");
  }

  function addForm() {
    const field = (id, label, attrs = {}) =>
      el("div", {}, el("label", { for: id }, T(label)), el("input", { id, type: "text", autocomplete: "off", spellcheck: "false", ...attrs }));
    return el("div", { class: "card" },
      field("hyLabel", "Ad", { maxlength: "80" }),
      field("hyHost", "Adres"),
      field("hyPort", "Port", { value: "22", inputmode: "numeric" }),
      field("hyUser", "Kullanıcı"),
      el("div", { class: "row" },
        el("label", { class: "inline" }, el("input", { type: "radio", name: "hyAuth", value: "key", checked: true }), " " + T("SSH anahtarı")),
        el("label", { class: "inline" }, el("input", { type: "radio", name: "hyAuth", value: "password" }), " " + T("Parola"))),
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: add }, T("Ekle")),
        el("button", { class: "ghost", onclick: () => { adding = false; render(); } }, T("Vazgeç"))));
  }

  async function add() {
    const port = Number($("hyPort").value || "22");
    const auth = document.querySelector("input[name=hyAuth]:checked");
    const next = await run("hybrid_add", {
      label: $("hyLabel").value, host: $("hyHost").value, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
      user: $("hyUser").value, authKind: auth ? auth.value : "key",
    });
    if (next) { adding = false; view = next; render(); }
  }

  async function importConfig() {
    const result = await run("hybrid_import");
    if (result) {
      notice = T("{a} sunucu eklendi, {s} zaten kayıtlıydı.", { a: result.added, s: result.skipped });
      view = result.view;
      render();
    }
  }

  async function verifyHost(host, accept) {
    const password = $("hyPw-" + host.id);
    const result = await run("hybrid_verify", {
      id: host.id, password: password && password.value ? password.value : null, acceptFingerprint: accept || null,
    });
    if (!result) return;
    const o = result.outcome;
    if (o.status === "hostKeyUnknown") verify[host.id] = { fingerprint: o.fingerprint, algorithm: o.algorithm };
    else if (o.status === "hostKeyChanged") verify[host.id] = { changed: true, fingerprint: o.fingerprint };
    else { delete verify[host.id]; notice = host.label + ": " + T("Bağlantı başarılı."); }
    view = result.view;
    render();
  }

  async function setAccess(host, changes) {
    const next = await run("hybrid_set", {
      id: host.id,
      remote: changes.remote ?? host.remote,
      preset: changes.preset ?? host.preset,
      sudo: changes.sudo ?? host.sudo,
    });
    if (next) { view = next; render(); } else render();
  }

  function hostItem(host) {
    const badges = el("span", { class: "badge" }, host.remote ? T("Paylaşılıyor") : T("Yalnız elle"));
    const head = el("div", { class: "meta" }, el("strong", {}, host.label), badges, el("span", { class: "time" }, host.target));
    const body = [];
    if (host.blocker && !host.remote) {
      body.push(el("p", { class: "small muted" }, T(ERRORS[host.blocker] || host.blocker)));
      if (host.blocker !== "not_ssh") {
        const v = verify[host.id];
        if (v && v.changed) {
          body.push(el("p", { class: "small", style: "color: var(--danger)" }, T("Sunucunun kimliği değişmiş! Bu bir saldırı olabilir; sunucuyu kontrol etmeden devam etme.")));
          body.push(el("code", {}, v.fingerprint));
        } else if (v) {
          body.push(el("p", { class: "small" }, T("İlk bağlantı: bu parmak izini sunucununkiyle karşılaştır; yalnız tanıyorsan güven.")));
          body.push(el("code", {}, `${v.algorithm || ""} ${v.fingerprint}`.trim()));
          body.push(el("div", { class: "row" },
            el("button", { class: "primary", onclick: () => verifyHost(host, v.fingerprint) }, T("Bu anahtara güven")),
            el("button", { class: "ghost", onclick: () => { delete verify[host.id]; render(); } }, T("Vazgeç"))));
        }
        if (!v) {
          const needsPassword = host.authKind === "password";
          body.push(el("div", { class: "row" },
            needsPassword ? el("input", { id: "hyPw-" + host.id, type: "password", placeholder: T("Parola (gerekiyorsa)"), autocomplete: "off" }) : null,
            el("button", { onclick: () => verifyHost(host) }, T("Bağlan ve doğrula"))));
        }
      }
    } else {
      const sw = el("input", { type: "checkbox", checked: host.remote, disabled: host.remote && !host.servedHere });
      sw.addEventListener("change", () => setAccess(host, { remote: sw.checked }));
      body.push(el("label", { class: "switch" }, sw, " " + T("Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)")));
      if (host.remote && !host.servedHere) body.push(el("p", { class: "small muted" }, T("Başka bir bilgisayar üzerinden paylaşılıyor.")));
      const preset = el("select", { "aria-label": T("Onaylı (önerilen)") },
        el("option", { value: "approval", selected: host.preset !== "readonly" }, T("Onaylı (önerilen)")),
        el("option", { value: "readonly", selected: host.preset === "readonly" }, T("Salt okunur")));
      preset.addEventListener("change", () => setAccess(host, { preset: preset.value }));
      const sudo = el("select", { "aria-label": "sudo" },
        el("option", { value: "never", selected: host.sudo !== "sudoers" }, T("Sudo: asla")),
        el("option", { value: "sudoers", selected: host.sudo === "sudoers" }, T("Sudo: sunucudaki sudoers izinleri")));
      sudo.addEventListener("change", () => setAccess(host, { sudo: sudo.value }));
      body.push(el("div", { class: "row" }, preset, sudo));
      body.push(el("p", { class: "small muted" }, host.preset === "readonly"
        ? T("Dosyaları okur, klasörleri listeler, sunucunun durumuna bakar. Komut çalıştıramaz, dosya yazamaz.")
        : T("Her komut ve dosya değişikliği, tam komutu gösteren tek kullanımlık onayla çalışır (Onaylar sekmesi, bildirim ya da web).")));
    }
    if (host.protocol === "ssh" || host.protocol === "mosh") {
      body.push(rootAsk && rootAsk.id === host.id
        ? rootConfirm(host, rootAsk.allow)
        : el("div", { class: "row" },
            el("button", { class: "ghost", onclick: () => { rootAsk = { id: host.id, allow: true }; render(); } }, T("Yapay zekâya root izni ver (bu sunucuda)")),
            el("button", { class: "ghost", onclick: () => { rootAsk = { id: host.id, allow: false }; render(); } }, T("Root iznini kaldır"))));
    }
    body.push(deleting === host.id
      ? el("div", { class: "row" },
          el("span", { class: "small" }, T("Bu sunucu silinsin mi? Kayıtlı parolası da silinir.")),
          el("button", { class: "danger", onclick: async () => {
            deleting = null;
            const next = await run("hybrid_delete", { id: host.id });
            if (next) view = next;
            render();
          } }, T("Evet, sil")),
          el("button", { class: "ghost", onclick: () => { deleting = null; render(); } }, T("Vazgeç")))
      : el("div", { class: "row" }, el("button", { class: "ghost", onclick: () => { deleting = host.id; render(); } }, T("Sil"))));
    return el("li", { class: "item" }, head, ...body);
  }

  function render() {
    const root = $("tab-ssh");
    if (!root || !view) return;
    // Do not rebuild under the person's typing (add form, password field).
    const focused = document.activeElement;
    if (focused && root.contains(focused) && focused.tagName === "INPUT" && focused.type !== "checkbox") return;
    const parts = [
      el("p", { class: "muted small" }, T("Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai) paylaştığın SSH sunucularını bu bilgisayar üzerinden kullanabilir. Sunucuya hiçbir şey kurulmaz; SSH anahtarın ve parolan bu bilgisayardan çıkmaz. Sen açmadıkça hiçbir yapay zekâ bir sunucuyu göremez.")),
      el("div", { class: "card" },
        el("div", { class: "device" },
          el("span", { class: view.status.running && view.status.online ? "dot on" : "dot" }),
          el("strong", { class: "small" }, statusText(view.status))),
        el("p", { class: "small muted" }, T("Bu bilgisayar kapalıyken ya da uygulama açık değilken uzak yapay zekâ bu sunuculara ulaşamaz."))),
    ];
    if (!view.keyring) parts.push(el("p", { class: "banner" }, T("Anahtar zinciri (Secret Service) bulunamadı: parolalar yalnız uygulama açıkken hatırlanır. Anahtar dosyası ya da SSH ajanı kullan.")));
    if (notice) parts.push(el("p", { class: "small" }, notice));
    if (rootDone) parts.push(rootNotice());
    parts.push(el("div", { class: "row" },
      el("button", { onclick: importConfig }, T("~/.ssh/config'den içe aktar")),
      el("button", { onclick: () => { adding = true; render(); } }, T("Sunucu ekle"))));
    if (adding) parts.push(addForm());
    if (view.hosts.length === 0) parts.push(el("p", { class: "empty" }, T("Henüz kayıtlı SSH sunucusu yok. ~/.ssh/config'den içe aktar ya da sunucu ekle.")));
    else parts.push(el("ul", { class: "list" }, ...view.hosts.map(hostItem)));
    parts.push(el("p", { class: "small muted" }, T("SSH ile çalıştırılan komutlarda klasör sınırı uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı kullan.")));
    parts.push(el("p", { class: "small muted" }, "🔒 " + T("Onay ekranı her zaman tam komutu gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır · Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.")));
    root.replaceChildren(...parts);
  }

  async function refresh() {
    if (busy || $("tab-ssh").hidden) return;
    try {
      view = await invoke("hybrid_view");
      render();
    } catch (error) {
      showError(error);
    }
  }

  // Called by app.js when the tab opens; refreshes the status while it is shown.
  window.hybridShow = () => {
    refresh();
    if (!timer) timer = setInterval(() => { if (!$("tab-ssh").hidden) refresh(); }, 5000);
  };
  window.hybridTabName = T("SSH sunucuları");
})();
