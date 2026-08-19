# HoptoNode

Pterodactyl ritminde, kendi markasıyla yazılmış oyun sunucusu kontrol paneli.
SQL yok — kullanıcılar, sunucular, oturumlar ve denetim kaydı `data/*.json` dosyalarında.

## Ne var

- Kurucu ve yönetici rolleri
- Java Vanilla, Paper, Fabric, Forge, NeoForge, Quilt
- Bedrock Dedicated, PocketMine-MP, NukkitX
- Konsol (WebSocket), dosya yöneticisi, güç eylemleri
- Reklam yok
- Personel hesaplarında panel üst limiti yok (kaydırıcı 64 GB / yüksek CPU)

## İlk hesaplar

| Rol | Kullanıcı | Parola |
|-----|-----------|--------|
| Kurucu | `kurucu` | `Kurucu#2026` |
| Yönetici (arkadaş) | `arkadas` | `Admin#2026` |

Girişten sonra parolaları **Hesap** sayfasından değiştir.

## Çalıştırma

```bash
cd hoptonode
npm install
npm start
```

Panel `0.0.0.0:8080` dinler.

## Dürüst sınırlar

HoptoNode bir **paneldir**, sihirli bir barındırıcı değil.

- Minecraft süreci, panelin çalıştığı makinenin Java / PHP / Bedrock ikilisine ve RAM’ine bağlıdır.
- VDS, node veya ev bilgisayarı olmadan 7/24 sunucu tutulamaz. Bu fiziksel bir sınırdır.
- “Sınırsız RAM/CPU” yalnızca kota kapatmasıdır. İşletim sistemi, makinede olmayan belleği veremez.
- Bu ortam geçicidir; kapanınca süreçler ve geçici paketler gider. Kalıcı tutmak istediğin dosyalar `/home/user/hoptonode` altındadır.

JAR / `PocketMine-MP.phar` / `bedrock_server` dosyasını sunucunun dosya yöneticisinden yükle, sonra **Başlat**.

## Cloudflare Tunnel (kendi hesabın)

Panel bir origin ister. Kendi makinenizde:

```bash
cloudflared tunnel login
cloudflared tunnel create hoptonode
cloudflared tunnel route dns hoptonode panel.senindomainin.com
cloudflared tunnel run hoptonode
```

`config.yml` içinde `http://127.0.0.1:8080` gösterin. Token olmadan buradan sizin adınıza tünel açılamaz; domain de sizin registrar’ınızdan alınır.

## Lisans notu

Arayüz ve kod orijinaldir. Minecraft, Paper, Fabric, Forge, PocketMine ve Bedrock kendi lisans / EULA kurallarına tabidir.
