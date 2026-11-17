# ÇiftSatır

İngilizce öğrenmek için **çift altyazı** tarayıcı eklentisi.
Üstte İngilizce cümle, altında Türkçe çevirisi. İngilizce kelimelere tıklayınca
video durur ve kelime paneli açılır: anlam, kelime türü, US/UK telaffuz, kelimenin
geçtiği gerçek altyazı cümlesi ve 5 örnek cümle. Beğendiğin kelimeleri **☆** ile
kaydedersin; kaydedilenler hem eklentide hem öğrenme sitesinde aynı kütüphanede
görünür.

Hedef tarayıcı: **Opera GX** (Chromium tabanlı, Manifest V3).

## Kurulum

1. Opera GX'te `opera://extensions` adresini aç.
2. Sağ üstten **Geliştirici modu**'nu aç.
3. **Paketlenmemiş öğe yükle** → `C:\Users\fatih\CiftSatir` klasörünü seç.
4. Kod değiştirdikçe eklenti kartındaki **Yenile** düğmesine bas ve sekmeyi yenile.

Öğrenme sitesi ayrı bir projedir: `C:\Users\fatih\ceviri-projesi`.
`npm start` → <http://127.0.0.1:5173/>. Popup'taki **İngilizce Öğrenme Sitesini Aç**
düğmesi bu adresi açar; sunucu kapalıysa aynı sitenin derlenmiş tek dosyası
(`Ceviri-Kitabi.html`) açılır. Adresler **Gelişmiş ayarlar**'dan değiştirilebilir.

## Ne yapar

| Alan | Davranış |
|---|---|
| YouTube | Önce `video.textTracks`; oynatıcı altyazıyı kendi DOM katmanına çiziyorsa (çoğu oturumda böyle) canlı DOM satırı okunur. Otomatik altyazı parçaları **cümle tamamlanana kadar** birleştirilir, kelime kelime gösterilmez |
| Netflix | Oynatıcının DOM'a çizdiği satırlar canlı yakalanır (gerçek track varsa ona bırakır) |
| Diğer HTML5 | `<track>` / TextTrack okuyucu; oynatıcı `.vtt`/`.srt` dosyasını ağdan çekiyorsa yakalanır; olmayan sitelerde sürükle-bırak |
| TR altyazı | Varsa doğrudan kullanılır; yoksa İngilizce satırlar ücretsiz çeviriyle üretilir |
| Kelime | Tıklayınca video durur, panel açılır; `▶ Videoyu sürdür` ile devam eder |
| 5 cümle | Anahtarsız ücretsiz kaynaklardan; aynı kelime tekrar açılınca yeni cümleler önceliklendirilir |
| Yıldız | Kelime, anlam, tür, örnekler, altyazı cümlesi ve tarih ortak kütüphaneye yazılır |
| Popup | Ana anahtar, EN/TR, boyut, konum, gerçek kelime sayısı, site/kütüphane kısayolu, teşhis |

## Test

Tarayıcı gerektirmeyen betikler:

```powershell
cd C:\Users\fatih\CiftSatir

node test/parser-check.js          # SRT/VTT ayrıştırma, cue araması, kök bulma
node test/worker-check.js          # sağlayıcı zinciri, devre kesici, çökmüş API senaryosu
node test/load-order-check.js      # service worker import sırası ve bağımlılıkları
node test/lang-check.js            # İngilizce/Türkçe/yabancı dil ayrımı
node test/network-check.js         # canlı API'lerin durumu (ağ gerekir)
node test/bridge-check.js          # eklenti ↔ site köprüsü (21 kontrol)
node test/ui-check.js              # popup kimlikleri, mesaj türleri, manifest izinleri
node test/cue-translate-check.js   # İngilizce-only video için satır çevirisi mantığı
node test/adaptor-check.js         # YouTube + Netflix adaptörleri (simülasyon)
node test/players-check.js         # 8 oynatıcı altyapısı + kaynak değişimi (91 kontrol)
node test/popup-check.js           # popup durumları: takılan mesaj, retry, kalıcılık (13 kontrol)
node test/youtube-harvest-check.js # YouTube ikinci dil toplayıcısı + json3 yedeği (11 kontrol)
```

Gerçek tarayıcı testi (Edge gerekir):

```powershell
node test/live-check.js            # gerçek Edge + gerçek eklenti (18 canlı kontrol)
node test/lifecycle-check.js       # gerçek Edge: video/sayfa değişimi, kalıcılık (53 kontrol)
node test/live-youtube-dom.js      # YouTube origin'inde DOM altyazı yolu (14 kontrol)
node test/live-netflix-dom.js      # Netflix origin'inde DOM altyazı yolu (7 kontrol)
```

`live-check.js` gerçek tarayıcıya eklentiyi yükler; service worker'ın başladığını,
içerik betiğinin enjekte olduğunu, gerçek bir cue'nun çizildiğini, popup'ın sekmeyle
konuşabildiğini, **eklenti kurulmadan önce açılmış sekmeye sonradan enjeksiyonu**,
**iframe içindeki oynatıcıyı**, **oynatıcının XHR ile çektiği `.vtt`'yi**
(uzantısız `text/vtt` adresleri dahil) ve **Öğrenme Sitesini Aç düğmesinin sunucu
kapalıyken dosyayı açmasını** doğrular.

`lifecycle-check.js` ise "bazen çalışıyor" şikâyetinin kaynağını hedefler. Her
senaryo gerçek bir Chromium'da, gerçek eklentiyle çalışır:

| Senaryo | Ne kanıtlanır |
| --- | --- |
| kısa oynatıcı (150 px) | satır sığmadığında gizlenmez, taşırılmaz |
| duraklatılmışken kaydırma | `position: fixed` katman videoyu takip eder |
| geç gelen `<track>` (3,5 sn sonra) | `addtrack`/`load` ile yakalanır |
| aynı `<video>`'da yeni track | eski cue temizlenir, yenisi gelir |
| yeni `<video>` öğesi | eski katman kaldırılır, tek katman kalır |
| altyazısız sayfa | uydurma satır yok, durum "cue yok" |
| tam ekran giriş/çıkış | katman fullscreen kapsayıcısına taşınır ve geri döner |
| duraklat / ileri sar / geri sar | satır her konumda doğru |
| sayfa yenileme | her şey sıfırdan geri gelir |
| kapat/aç, EN/TR anahtarları | katman ve satırlar gerçekten gizlenir |
| `video.src` (blob) değişimi | aynı öğede altyazı yeniden kurulur |
| çevrimdışı çeviri | EN çalışmaya devam eder, ağ dönünce TR gelir |
| tekrar enjeksiyon | tek katman kalır |
| tanılama | `stage`, `platform`, `cueCount`, `layer` raporlanır |

`live-youtube-dom.js` ve `live-netflix-dom.js`, gerçek platform alan adında
(`https://www.youtube.com`, `https://www.netflix.com`) **kontrollü bir HTML**
servis eder. Amaç, platform adaptörünün gerçekten bağlı olduğu DOM yolunu
doğrulamak: `textTracks` boşken `.ytp-caption-segment` / `.player-timedtext`
okunuyor mu, aynı `<video>` üzerinde başka videoya geçince eski satır siliniyor
mu, altyazı kapanınca satır temizleniyor mu. **Gerçek YouTube/Netflix hesabı ve
DRM'li içerik bu testlerde yoktur**; o adım elle yapılmalıdır.

Opera GX yerine Edge kullanır (aynı Chromium motoru); `playwright-core`
`ceviri-projesi/node_modules` içinden alınır.

Site tarafı:

```powershell
cd C:\Users\fatih\ceviri-projesi
node arac/derle.js                 # tek HTML derlemesi
node tests/bridge.js               # sitenin köprü yarısı (19 kontrol)
node tests/smoke.js                # gerçek tarayıcı, 25 test
```

`test/test-page.html` elle deneme içindir: `<track>` yolu, dosya sürükleme ve
`fetch()` ile VTT çekme. Altyazıyı senkronlamak için videoda **`[`** ve **`]`**
0,25 sn kaydırır; paneli kapatmak için **Escape**.

> **Önemli:** Bu depodaki otomatik testler mantığı ve mesajlaşmayı doğrular.
> Gerçek YouTube/Netflix hesabında uçtan uca deneme bu ortamda yapılamadı;
> aşağıdaki "Bilinen sınırlamalar" bölümü bu yüzden açık bırakıldı.

## Mimari

İki kısıt yapıyı belirliyor:

1. Content script'in `localStorage`/IndexedDB'si **sayfanın** origin'ine aittir,
   eklentinin değil → kalıcı veri orada tutulamaz.
2. Content script'in `fetch`'i sayfanın CORS'una tabidir → üçüncü parti API'ler
   güvenilir şekilde çağrılamaz.

Bu yüzden **tüm ağ istekleri ve tüm kalıcı depolama service worker'da**; content
script sadece arayüz, altyazı zamanlaması ve mesajlaşma yapar.

```
manifest.json
background/service-worker.js   Mesaj yönlendirici; ağ + kalıcı depolama
content/
  content.js          Video yaşam döngüsü, ayarlar, tıklama, otomatik TR çeviri
  overlay.js          Çift satır overlay + konum/boyut + tam ekran
  words.js            İngilizce satırı tıklanabilir kelime <span>'lerine böler
  panel.js            Kelime paneli: anlam, IPA, US/UK ses, 5 cümle, yıldız
  capture-bridge.js   MAIN world → ISOLATED world köprüsü
  site-bridge.js      Öğrenme sitesiyle ortak kütüphane köprüsü
adaptors/
  registry.js         Adaptör arayüzü; `live` adaptörleri de kabul eder
  generic-track.js    <video> + <track>/TextTrack okuma
  embedded-track.js   DPlayer/ArtPlayer: kind="metadata" taşıyan gerçek cue listesi
  dom-caption.js      Son çare: oynatıcının kendi DOM katmanındaki güncel satır
  youtube.js          YouTube: track seçimi, karaoke temizliği, cuechange + DOM satırı,
                      otomatik altyazıyı cümle cümle birleştirme
  netflix.js          Netflix: DOM'dan canlı satır yakalama
  manual-file.js      Sürükle-bırak .srt/.vtt
  network-capture.js  MAIN world: fetch/XHR/blob yakalama, erken istek replays
shared/
  stemmer.js          Kelime → kök adayları
  sentence-builder.js Otomatik altyazı parçalarını cümleye birleştirme
  parsers.js          SRT / VTT / YouTube json3 / srv3 ayrıştırıcı
  cue-model.js        Cue modeli + CueStore (ikili arama)
  cue-translate.js    Otomatik TR satırı: hangi satır, hangi zamanlama
  cache.js            Bellek LRU + IndexedDB
  library.js          Ortak kütüphane (şema, birleştirme, tombstone)
  starred.js          Eski yıldız deposundan tek seferlik taşıma
  lang-detect.js      Dil tespiti (İngilizce / Türkçe / yabancı)
  messaging.js        Tipli mesaj yardımcıları
  providers/          google, mymemory, free-ai, tatoeba, wiktionary, claude
ui/popup.*            Tek ekran kontrol paneli
test/                 Tarayıcısız testler, gerçek oynatıcı testleri, örnek altyazılar
test/vendor/          Video.js, Plyr, DPlayer, ArtPlayer, hls.js + örnek medya
test/players/         Oynatıcı başına bir test sayfası (native … custom-canvas)
```

### Yeni site eklemek

`adaptors/` altına bir dosya ekle ve `DS.adaptorRegistry.register(...)` ile kaydet:

```js
{
  id: 'site-adi',
  priority: 60,                              // yüksek olan önce denenir
  matches(video, ctx) { return /site\.com/.test(location.hostname); },
  async attach(video, ctx) {
    ctx.emit('cues', { kind: 'en', cues: [...] });   // 'en' veya 'tr'
    return { en: {...}, tr: {...}, detach() {} };
  }
}
```

Cue'ları `attach` döndükten sonra da `ctx.emit` ile itebilirsin. Hiç cue yoksa
`return { live: true, detach }` ile "sonra göndereceğim" diyebilirsin (Netflix
böyle çalışır); registry canlı adaptörü kabul eder. Yeni dosyayı `manifest.json`
içindeki `content_scripts[0].js` listesine eklemeyi unutma.

### Altyazı oturumu (v1.4.0)

Adaptör bağlama artık bir "oturum" kavramına dayanır. `content/content.js` her
denemede bir **kaynak anahtarı** üretir:

```
currentSrc/src + her text track'in (kind, dil, etiket, cue sayısı, ilk satır)
```

- Anahtar değişmediyse deneme hiçbir şey yapmaz. Bu yüzden `timeupdate`, DOM
  gözlemcisi ve medya olayları aynı kaynağı defalarca yeniden bağlamaz.
- Anahtar değiştiyse (YouTube'da başka videoya geçmek, aynı `<video>`'ya yeni
  `<track>`, HLS kalite değişimi) eski adaptör `detach()` edilir, iki kanal
  `store.clear()` ile boşaltılır ve yeni kaynak sıfırdan okunur. Eski satırın
  ekranda kalması bu yüzden imkansız.
- Geç gelen altyazılar için `textTracks.addtrack` / `track.load` dinlenir; bu
  olaylar retry bütçesini de sıfırlar. Yani 10 saniye sonra gelen track de
  yakalanır. Ek olarak sınırlı bir zamanlayıcı zinciri (0,4 → 8 sn) vardır.
- Canlı adaptörlerde (YouTube DOM, Netflix) cue `attach` anında yoktur; bu
  yüzden onlar için retry zinciri çalışmaz, adaptör kendi satırını bekler.

### Çoklu oynatıcı desteği (v1.5.0)

Film/dizi siteleri tek bir oynatıcı kullanmaz. Aynı eklenti dört ayrı veri yolunu
birlikte kullanır; her yol bağımsızdır ve biri bozulduğunda diğerleri çalışmaya
devam eder:

1. **Standart `<video>` / `textTracks`** — `generic-track.js`. Dil `srclang` /
   etiketten, o yoksa cue metninden okunur. Oynatıcının kendi katmanı
   `track.mode = 'hidden'` ile kapatılır.
2. **Oynatıcının kendi track listesi** — Video.js `<track>` elementini kaldırıp
   cue'ları kendi `textTracks()` listesinde tutar. Bu liste sayfa dünyasındadır ve
   içerik betiğinden görünmez; bu yüzden Video.js altyazısı **ağ yakalamasıyla**
   alınır (`network-capture.js`).
3. **`kind="metadata"` track'i** — DPlayer ve ArtPlayer altyazı `<track>`'ini
   `metadata` olarak ekler, tarayıcıya ayrıştırtır ve kendi katmanına çizer.
   `embedded-track.js` bu cue listesini okur; normal `subtitles` track'i varsa
   asla devreye girmez.
4. **Yalnızca DOM'a çizilen satır** — JW Player benzeri oynatıcılar metni bir
   API/WebSocket'ten alıp `.jw-text-track-display`, `.vjs-text-track-display`,
   `.plyr__captions`, `.dplayer-subtitle`, `.art-subtitle`,
   `.shaka-text-container` gibi kutulara yazar. `dom-caption.js` en düşük
   öncelikte bu kutudan **yalnızca ekrandaki satırı** okur. Ağdan tam dosya
   geldiğinde kendini durdurur ve yerini bırakır; canlı satır tam bir track'in
   üzerine yazamaz.

Ağ katmanı (`network-capture.js`) üç somut sorunu çözecek şekilde genişletildi:

- **Erken istek**: betik `document_start`'ta çalışır, dinleyici ise
  `document_idle`'da kurulur. Oynatıcı altyazıyı sayfa ayrıştırılırken
  indiriyorsa (DPlayer, ArtPlayer, JW Player) yanıt dinleyiciden önce gelirdi.
  Yakalanan gövdeler tamponlanır; köprü hazır olduğunda ve her kaynak
  değişiminde `dualsub-capture-ready` / `dualsub-capture-replay` ile yeniden
  gönderilir.
- **Uzantısız / `application/octet-stream` altyazı**: eski kod yalnızca dosya
  uzantısına veya altyazı MIME'ına bakıyordu; `/sub?id=42` gibi bir URL ve
  `octet-stream` yanıtı sessizce atlanıyordu. Artık metin benzeri gövdeler
  (video/ses/görüntü hariç) `-->` / `WEBVTT` için koklanır.
- **Bölüm değişimi**: her yakalanan yük, o anda oynayan medyanın URL'siyle
  etiketlenir. Kaynak değişiminde eski bölümün dosyası yeni oturuma karışmaz;
  yeni dosya eski dosyadan farklı URL/first-line taşıyorsa İngilizce kanalı
  devralır. Aynı dosyanın yeniden indirilmesi yinelenen cue üretmez.

Çift satır görünürken oynatıcının kendi altyazı kutusu
`html.dualsub-own-captions` sınıfıyla gizlenir (Video.js, Plyr, DPlayer,
ArtPlayer, JW Player). Gizleme yalnızca bizim satırımız gerçekten ekrandayken
uygulanır: yakalama başarısız olursa oynatıcının kendi altyazısı görünür kalır.

### Tanılama

`content.js` içinde `state.diag` tek bir küçük kayıt tutar: `stage` (`idle`,
`video`, `waiting-subtitle`, `source-attached`, `active`, `unsupported`, `error`),
`platform`, `adaptor`, `cueCount`, `translated`, `error`, `errorStage`. Popup
bunu "platform · aşama · kaynak · cue · TR durumu" satırı olarak gösterir; aynı
bilgi `get-state` ve `diagnose` yanıtlarındadır. Konsola yalnızca
`?dualsub-debug=1` ile açıkken ve her aşama için **bir kez** yazılır.

## Çeviri katmanı

Anahtar gerekmez.

| İş | Sıra |
|---|---|
| Türkçe anlam | Google gtx → MyMemory → ücretsiz AI |
| 5 örnek cümle | Pollinations (ücretsiz AI) → Tatoeba → ikinci AI denemesi |
| Altyazı satırı (TR track yoksa) | Google gtx → MyMemory |
| İngilizce sözlük | Wiktionary + Free Dictionary API (paralel) |
| US/UK telaffuz | Tarayıcının `speechSynthesis` sesi |

- **Devre kesici:** Üst üste 3 kez hata veren sağlayıcı 5 dakika atlanır; çökmüş
  bir API her kelimede 2,5 sn bekletmez.
- **Önbellek:** Anlamlar ve cümleler IndexedDB'de tutulur; aynı kelime ikinci kez
  açıldığında ağa çıkılmaz.
- **Tekrar önleme:** 5 cümle için daha önce gösterilenler kaydedilir, yeni istekte
  önce görülmemiş cümleler seçilir. Yeterli yeni cümle yoksa arayüz bunu söyler,
  sessizce aynı cümleleri "yeni" diye göstermez.
- **Claude (isteğe bağlı):** Anahtar girilirse yalnızca cümle üretiminde yedek
  olarak kullanılır. Anahtar `chrome.storage.local`'da tutulur ve yalnızca
  service worker okur. Zorunlu değildir.

⚠️ Bir tarayıcı eklentisinde saklanan API anahtarını, o tarayıcı profiline erişen
herkes okuyabilir. Kişisel kullanım için kabul edilebilir; dağıtım için değil.

## Ortak kütüphane (site ↔ eklenti)

İki taraf ayrı depolara sahiptir; biri diğerini doğrudan okuyamaz. Bu yüzden aynı
sekmede `window.postMessage` ile konuşurlar:

- Site tarafı: `src/js/library-bridge.js`
- Eklenti tarafı: `content/site-bridge.js`
- Kaynak etiketleri: `ck-site` / `dualsub-ext`

Kurallar:

- Köprü yalnızca site selam verdiğinde konuşur; Netflix/YouTube sayfasında sessizdir.
- Site → eklenti: `ready`, `upsert` (tek kelime veya anlık görüntü), `unstar`.
- Eklenti → site: `hello`, `sync` (tam liste), `upsert`, `unstar`.
- Birleştirme **union**'dır; aynı kelime ikinci kez eklenmez.
- Silinen kelime eklenti tarafında **tombstone** olarak işaretlenir; eski bir tam
  liste onu geri getiremez.
- Site yalnızca eksik kelimeleri ekler, var olan kaydı ezmez.
- Sunucu yoktur, ek izin yoktur. `file://` ile açılan derlenmiş HTML'de köprü
  çalışır ama Opera'da eklenti için **"Dosya URL'lerine erişime izin ver"**
  açılmalıdır.

Popup'taki kelime sayısı bu ortak kütüphaneden gelir (`library-count`), sabit bir
sayı değildir.

## İzinler

`manifest.json` yalnızca gerçekten çağrılan adreslere erişim ister:

```
activeTab, scripting, storage
translate.googleapis.com, api.mymemory.translated.net, text.pollinations.ai,
tatoeba.org, api.dictionaryapi.dev, *.wiktionary.org, api.anthropic.com,
127.0.0.1, localhost
```

`scripting` yalnızca, eklenti yüklenmeden önce açılmış bir sekmeye içerik betiğini
sonradan enjekte etmek için kullanılır (popup bağlantı kuramazsa otomatik dener).
`127.0.0.1` / `localhost` yalnızca yerel öğrenme sitesine erişim içindir.

`<all_urls>` yalnızca content script'in hangi sayfalarda çalışacağını belirtir;
ağ izni değildir. `tabs` izni istenmez.

## Bilinen sınırlamalar

- **Netflix:** Altyazı DOM'a çizildiği için yalnızca **izlenmiş** satırlar
  yakalanır. Geriye sarıp daha önce hiç görülmemiş bir sahneye gidilirse o
  satırlar boş kalır. Bitmap (resim) altyazılar okunamaz. Netflix'te dil olarak
  Türkçe seçiliyse yakalanan satır Türkçedir; tıklanacak İngilizce satır olmaz.
- **YouTube:** Önce TextTrack okunur. YouTube çoğu oturumda altyazıyı `video.textTracks`
  yerine kendi DOM katmanına çizdiği için o katman da canlı okunur; bu yolda yalnızca
  **ekrandaki cümle** yakalanır (geçmiş/gelecek satırlar yoktur). Otomatik altyazı
  kelime kelime boyandığı için parçalar birleştirilir ve satır, cümle bitince
  (noktalama veya konuşma arası) bir bütün olarak gösterilir. Noktalama içermeyen
  çok uzun bir monolog en fazla 22 kelimede bölünür. Videoya gömülü (yakılmış)
  altyazı varsa okunacak metin yoktur; `.srt` sürüklenebilir.
- **Doğrulama:** YouTube'un altyazı isteği bu test ortamında (headless, bot koruması)
  boş döndüğü için **gerçek YouTube altyazısıyla uçtan uca deneme yapılamadı**. DOM
  yakalayıcısı simülasyonla; enjeksiyon, iframe ve ağ yakalama gerçek tarayıcıda
  doğrulandı. Kendi tarayıcında bir videoda CC'yi açıp bir kez bakman gerekir.
- **Kaçak siteler:** Oynatıcı altyazıyı `.vtt`/`.srt` olarak ağdan çekiyorsa yakalanır
  (XHR, fetch ve blob yolları). Oynatıcı altyazıyı resim olarak çiziyorsa veya şifreli
  bir API'den alıyorsa okunamaz; `.srt`/`.vtt` sürükle-bırak her zaman çalışır.
- **Free Dictionary API** zaman zaman 530 / zaman aşımı veriyor (25 Ekim 2026
  kontrolünde 200 döndü). IPA boş kalırsa Wiktionary ve devre kesici devreye girer;
  diğer özellikler etkilenmez.
- **5 cümle:** AI cümleleri dil bilgisi açısından kontrol edilmez; kaynak
  doğrulanamıyorsa arayüz `partial` uyarısı gösterir, gizlemez.
- **Telaffuz:** İşletim sisteminde US/UK sesi yoksa tarayıcı aynı sesi kullanabilir;
  sesin gerçekten aksanlı olması işletim sistemine bağlıdır.
- **Senkron:** Site ile eklenti yalnızca ikisi de açıkken anlık eşitlenir. Ayrı
  bir bulut hesabı yoktur; Supabase/DB kullanılmıyor.
- Eklenti yeni yüklendiyse açık sekmelerde içerik betiği yoktur; popup ilk açılışta
  onu kendisi enjekte etmeyi dener. Yine olmazsa sekmeyi bir kez yenile.

## Durum

Tamamlanan: ayrıştırıcılar, cue modeli, çift satır overlay, kelime tıklama + panel,
5 cümle + tekrar önleme, US/UK telaffuz, yıldızlama, ortak kütüphane + köprü,
yeni popup, YouTube (track + DOM) ve Netflix adaptörleri, İngilizce-only video için
otomatik TR satırı, izin daraltması, eksik içerik betiğini kendine enjekte eden
popup, sunucu kapalıyken çalışan site bağlantısı, 9 tarayıcısız + 2 gerçek tarayıcı testi.

Kararlılık turu (v1.4.0): altyazı oturumu kaynak anahtarına bağlandı (aynı `<video>`
yeni video/track aldığında eski cue'lar ve adaptör temizleniyor), geç gelen track'ler
`addtrack`/`load` ile yakalanıyor, tam ekran/pencere/kaydırma konumu düzeltildi,
küçük oynatıcılarda katman gizlenmiyor, EN/TR satır anahtarları gerçekten çalışıyor,
çeviri hatası EN satırını durdurmuyor ve popup'ta aşama/platform/kaynak göstergesi var.

Cümle modu (v1.5.1): YouTube otomatik altyazısı artık kelime kelime değil,
cümle tamamlanınca tek parça gösteriliyor. Aynı birleştirme otomatik TextTrack
cue'larına ve YouTube'un `json3` / `srv3` timedtext yanıtlarına da uygulanıyor.
"Yalnızca Türkçe" şikâyeti için ikinci dil toplayıcısı güçlendirildi: oynatıcının
canlı `getPlayerResponse()` listesi okunuyor, İngilizce parça VTT boş dönerse
`json3`, o da olmazsa `srv3` ile isteniyor ve oynatıcının kendi `timedtext`
isteği de ağ katmanından yakalanıyor.

Sırada: gerçek YouTube sayfasında CC açıkken elle doğrulama; kaçak sitelerde
oynatıcı DOM sınıfı değişirse yakalayıcıyı güncelleme; istenirse bulut senkronizasyonu.

## hdfilmcehennemi hakkında

Araştırma sonucu (2026-10): site altyazıyı videoya gömmüyor. Oynatıcı **JW Player 8**,
altyazılar `tracks: [...]` içinde ayrı `.vtt` dosyaları (İngilizce + Türkçe dahil), ve bu
dosyalar `access-control-allow-origin: *` ile servis ediliyor. Yani okunabilirler.

Ancak iki engel var:

- Oynatıcı **cross-origin bir iframe** içinde (`.nl`/`.la` → `.mobi`) → `all_frames: true` şart
- JW Player `<track>` elementi **kullanmıyor**; VTT'yi XHR ile çekip kendi katmanına
  çiziyor → `video.textTracks` boş, ağ katmanından yakalamak gerekiyor

Bu iki engel artık kapatıldı: manifest'te `all_frames: true` + `match_about_blank: true`,
ve `adaptors/network-capture.js` sayfanın kendi `fetch`/`XHR`/`blob:` çağrılarını
MAIN world'de sarıp `.vtt`/`.srt` gövdesini yakalıyor. Bu yol gerçek tarayıcıda,
oynatıcının XHR ile `.vtt` çektiği bir test sayfasında doğrulandı. Yine de her
oynatıcı farklıdır: altyazıyı gizli bir API'den alıp çözüyorsa yakalanamaz; o
durumda `.srt`/`.vtt` dosyasını videonun üzerine sürüklemek tüm özellikleri açar.
