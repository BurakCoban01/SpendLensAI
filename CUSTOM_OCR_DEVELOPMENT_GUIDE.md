# Custom OCR Geliştirme Rehberi

Bu belge, SpendLensAI icin gelistirilen proje-ozel Turkish OCR sisteminin nasil calistigini, neden bu sekilde tasarlandigini ve nasil gelistirildigini bastan sona aciklar. Anlatim dogrudan depodaki kodu izler; genel bir yapay zeka ozeti degildir.

> Not: Kaynak kodundaki `Custom OCR` yolu Tesseract veya baska hazir OCR motoru kullanmaz. Tesseract ayri bir secilebilir karsilastirma motorudur. Custom OCR modeli hazir degilse sistem Tesseract'a gizlice gecmez; acik bir model-hazir-degil hatasi verir.

> Güncel durum: Custom OCR uçtan uca çalışan, yerel olarak eğitilebilen bir sistemdir; ancak model **production-ready değildir** ve son gerçek-fixture kalite kapısı geçememiştir. Bootstrap yalnızca inference smoke testi ve eşleşen gerçek-fixture benchmark kanıtı geçen modelleri aktif eder; geçemeyen adaylar `FAILED` kalır. Güncel kapı durumu için [MODEL_EVALUATION.md](MODEL_EVALUATION.md) dosyasına bakın. Tesseract üretim taban çizgisidir.

> EMNIST balanced verisi 4,700 eğitim ve 940 doğrulama karakter crop'i ile ölçüldü. Bu aday gerçek belge snippet recall ve Turkish-special F1 hedeflerini tutturamadığı için reddedildi; aktif modele alınmadı.

## 1. Sistem neyi cozuyor?

Bir fis, fatura veya dekont goruntusu bilgisayar icin once yalnizca renkli piksel dizisidir. Uretilecek sonuc ise sirali metin, satir ve kelime konumlari, guven puanlari ve tutar/tarih gibi alanlardir. Bu nedenle sistem tek bir modelden degil, birbirini izleyen asamalardan olusur:

```text
Goruntu veya PDF
  -> sayfa yukleme ve on isleme
  -> metin bolgesi ve satir segmentasyonu
  -> CRNN ile satir tanima
  -> dusuk guvenli satirlarda Fourier tabanli tani
  -> ham metin ve normalizasyon
  -> alan cikarma ve dogrulama
  -> guven kapisi ve kullanici incelemesi
  -> duzeltmelerin yeni egitim verisine aktarilmasi
```

Bu ayrim iki nedenle onemlidir. Ilki, bir asamadaki hata digerlerinden ayri olculebilir. Ikincisi, ham OCR tahmini korunurken tarih veya para bicimi gibi is kurallari daha sonra ve kontrollu uygulanabilir.

## 2. Merkezi karakter sozlugu

Kaynak: `services/ocr/custom_model/vocab.py`

Modelin okuyabilecegi her karakter tek bir listede tanimlidir. Bu liste Latin harfleri, rakamlari, Turkish karakterleri, finans sembollerini ve noktalama isaretlerini kapsar. `VOCAB_VERSION`, checkpoint ile API sonucunun ayni karakter eslemesini kullandigini kanitlar.

Turkish dilinde su dort karakter farkli siniflardir:

```text
i  I  İ  ı
```

Ayni sekilde `ç`, `ğ`, `ö`, `ş`, `ü` ve buyuk harfleri de ayri siniflardir. Kod bunlari ASCII benzerlerine cevirmeden `raw` tahminde saklar.

Karakterlerin modele verilmesi iki adimlidir:

1. `encode()` her karakteri sayisal sinif kimligine cevirir.
2. `decode()` CTC cikisindaki bos sinifi ve ardisik tekrarlarini kaldirarak metni geri kurar.

`<blank>` normal bir yazi karakteri degildir. CTC'nin "bu zaman adiminda karakter yok" anlamindaki ozel sinifidir. Bu nedenle gercek karakterler indeks 1'den baslar.

## 3. Veri neden ve nasil uretiliyor?

Kaynaklar:

- `services/ocr/custom_model/dataset.py`
- `services/ocr/custom_model/synthetic_text.py`
- `services/ocr/custom_model/synthetic_documents.py`
- `services/ocr/custom_model/augmentations.py`
- `services/ocr/custom_model/dataset_adapters.py`

Hazir OCR modeli kullanmadan model egitmek icin goruntu ile dogru metin eslesmelerine ihtiyac vardir. Sentetik veri ureticisinde metin once bilinir, sonra yerel fontlarla goruntuye cizilir. Boylece etiket Tesseract tahmininden degil, dogrudan uretilen metinden gelir.

### 3.1 Karakter verisi

Karakter CNN'i ve Fourier tabani icin her karakter ayri bir kirpim olarak uretilir. Font, boyut, konum ve goruntu bozulmalari degistirilir. Bir model yalnizca tek font gordugunde harfin kendisini degil o fontun bicimini ezberleyebilir; cesitlilik bu riski azaltir.

Turkish ozel karakterleri ve birbirine benzeyen gruplar daha sik uretilir:

```text
I / İ / ı / i / l / 1
O / Ö / 0
S / Ş / 5
G / Ğ
c / ç
u / ü
```

### 3.2 Satir verisi

CRNN tek tek karakter yerine bir satirin tamamini okur. Uretici, gercek finans belgelerine benzeyen satirlar kurar: isyeri adi, fis/fatura numarasi, tarih, KDV, toplam, odeme bicimi ve IBAN gibi.

Satir goruntuleri sabit genislikte zorla ezilmez. Metin uzunluguna gore genislik degisir; batch olusturulurken kisa satirlar en genis satira kadar boslukla doldurulur. Bu, uzun fatura numaralarinin veya IBAN'larin yatay olarak bozulmasini engeller.

### 3.3 Tam belge verisi

Belge ureticisi dar fis, genis fatura ve banka/dekont duzenleri kurar. Etiket yalnizca tam metni degil satir kutularini, belge turunu ve beklenen alanlari da icerir. Perspektif, dusuk kontrast, gurultu, golge ve termal kagit benzeri bozulmalar modelin sadece temiz ekran goruntulerini ezberlememesini saglar.

### 3.4 `document_lines` verisi

Ilk egitimlerde sentetik satirlar ile tam belgeden segmentasyonla cikan satirlarin goruntu olcegi farkliydi. Satir modeli kendi dogrulama verisinde ilerlerken tam belge CER degeri ayni oranda iyilesmiyordu.

Bu farki azaltmak icin `generate_document_line_dataset()` su akisi uygular:

1. Etiketli tam sentetik belge uretir.
2. Belgedeki gercek satir kutularini kullanarak satirlari kirpar.
3. Kirpimi inference sirasinda kullanilan boyut ve bosluk davranisina yakin bicimde saklar.
4. Manifest kaydina `synthetic_document_line_crop` kaynagini yazar.
5. `LineDataset`, bu kaynagi gorunce crop-preserving hazirlama yolunu kullanir.
6. Proje fixture ground-truth dosyalarindaki `expectedOcrTextSnippets` degerlerini render edilmis ek satirlar olarak ekler.

Boylece egitim ve gercek belge inference'i arasindaki olcek farki azaltildi.

Fixture snippet satirlari `project_real_fixture_rendered_snippet` kaynagi ile etiketlenir ve egitim metriklerinde `projectFixtureTrainingSamples` olarak sayilir. Bu kaynak yerel fis/fatura kelime dagilimini, Turkce karakterleri, tarihleri ve tutarlari egitime daha fazla sokar. Ancak bunlar gercek segmentasyon crop'i degildir; real fixture benchmark yerine gecmez ve tek basina production-ready kaniti sayilmaz.

### 3.5 Manifest ve split

Her veri kumesi bir manifest uretir. Manifest; goruntu yolu, etiket, kaynak, split ve uretim bilgisini tasir. `train`, `validation` ve `test` ayrimi, modelin egitimde gordugu orneklerle olculmesini engeller.

Uretilen veriler `data/`, checkpoint ve raporlar `artifacts/` altinda tutulur ve Git'e eklenmez. Public dataset adapter'lari lisans, boyut ve kurulum bilgisini kaydeder; kimlik bilgisi veya sessiz buyuk indirme gerektiren kaynaklar zorunlu degildir.

## 4. Goruntu on isleme

Kaynaklar:

- `services/ocr/custom_model/image_ops.py`
- `services/ocr/custom_model/preprocessing.py`

Modelin ham fotograf yerine daha tutarli bir goruntu gormesi gerekir. `preprocess_custom_document()` her PDF sayfasi veya goruntu icin su islemleri yapar:

1. Dosyayi yukler; PDF ise sayfalari goruntuye donusturur.
2. Renkli goruntuyu gri tona cevirir.
3. Adaptif esikleme ile metni on plandan ayirir.
4. Egikligi tahmin eder ve sayfayi OpenCV koordinatlarinda olculen duzeltme acisiyla dondurur.
5. Duzeltilmis sayfayi yeniden esikler.
6. Bulaniklik, kontrast, egiklik ve on-plan yogunlugu metriklerini hesaplar.

Adaptif esikleme tek bir global parlaklik siniri kullanmaz. Goruntunun farkli bolgelerinde yerel esikler hesaplandigi icin golgeli veya dusuk isikli kagitlarda daha dayaniklidir.

Kalite metrikleri OCR metnini degistirmez. Sonuca eklenir ve dusuk kalite durumunda review akisinin karar vermesine yardim eder.

OpenCV'nin `minAreaRect` aci yonu dikkatle ele alinmalidir. Ilk uygulama tahmin edilen acinin negatifini uyguladigi icin rotated belgeleri daha fazla egiyordu. Sabit benchmark'ta beklenen 9-12 satir yerine 1-5 satir bulunmasi bu hatayi ortaya cikardi. Olculen aciyi dogrudan uygulamak satir sayilarini geri getirdi ve rotated CER degerini `0.799669`dan `0.179590`a indirdi.

## 5. Segmentasyon: sayfayi okunabilir parcalara ayirma

Kaynak: `services/ocr/custom_model/segmentation.py`

Segmentasyon, hangi piksel grubunun hangi satira veya karaktere ait oldugunu belirler. Bu kod OpenCV'nin genel goruntu isleme ilkellerini kullanir; hazir metin detektoru veya Tesseract kutusu kullanmaz.

### 5.1 Connected components

Connected components, birbirine temas eden on-plan piksellerini bir grup olarak bulur. Her grup icin `x`, `y`, genislik, yukseklik ve alan hesaplanir. Cok kucuk lekeler elenir; sayfa kadar buyuk, metin olmayan sekiller sinirlandirilir.

### 5.2 Metin bolgesi

`detect_text_regions()` yatay agirlikli morfolojik genisletme uygular. Birbirine yakin harfler ayni satir/bolge gibi birlesir. Sonra connected components ile aday bolgeler cikarilir.

### 5.3 Satirlar

`segment_lines()` her yatay satirdaki on-plan piksel sayisini hesaplar. Aktif satirlar ard arda geldiginde bir kosu olusur. Her kosunun bos olmayan sol ve sag siniri bulunarak satir kutusu uretilir.

Noisy belgelerde rastgele noktalar bos bir yatay sirada eski `%1` esigini gecebildigi icin sahte satirlar ve birlesmis satirlar olusuyordu. Esik `%1,5` yapildi ve yogunlugu `%4`un altindaki run'lar reddedildi. Bu degisiklik noisy CER degerini `0.481863`dan `0.438789`a indirdi.

Sayfa cerceveleri ve uzun tablo cizgileri once `_remove_rule_lines()` ile temizlenir. Aksi halde bir cerceve tum belgeyi tek satir gibi gosterebilir.

### 5.4 Kelimeler

`segment_words()` bir satirin dikey projeksiyonunu inceler. Harfler arasindaki kucuk bosluklarla kelimeler arasindaki daha buyuk bosluklari ayirmak icin medyan bosluga dayali esik kullanir.

### 5.5 Karakterler ve Turkish aksanlari

`segment_characters()` kelime icindeki connected component kutularini cikarir. Nokta veya aksan bazen ana harften ayri component olur. `_merge_turkish_diacritics()` kucuk, ana harfin ustunde/altinda ve yatay olarak cakisan parcayi ana kutuyla birlestirir. Bu adim `İ`, `i`, `ğ`, `ö`, `ş`, `ü` ve `ç` icin kritiktir.

Segmentasyon kusursuz degildir. Dokunan harfler, cok soluk noktalar veya tablo cizgileri hata uretebilir. Bu nedenle sonuc satir ve karakter kutulariyla birlikte raporlanir; yalnizca duz metin verilmez.

## 6. Fourier descriptor ve cosine baseline

Kaynaklar:

- `services/ocr/custom_model/boundary.py`
- `services/ocr/custom_model/fourier_features.py`
- `services/ocr/custom_model/classical_classifier.py`

Bu yol sinir agi degildir. Ozellikle tek karakterleri aciklanabilir bir sekilde karsilastirmak ve dusuk guvenli CRNN satirlarinda tani uretmek icin kullanilir.

### 6.1 Sinir izleme

`trace_boundary()` esiklenmis karakterdeki en buyuk dis konturun noktalarini sirayla cikarir. Her nokta `(x, y)` koordinatidir. `hole_count()` ise `0`, `8`, `A` gibi ic boslugu bulunan sekilleri ayirmaya yardim eder.

### 6.2 Kompleks sayi dizisi

Her kontur noktasi su bicimde tek kompleks sayiya donusturulur:

```text
z = x + i*y
```

Noktalarin ortalamasi cikarilir. Bu, karakterin goruntu icindeki konumunu descriptor'dan buyuk olcude kaldirir.

### 6.3 FFT ve dusuk frekanslar

`np.fft.fft()` kontur dizisini frekans bilesenlerine ayirir. Dusuk frekanslar karakterin genel bicimini, yuksek frekanslar ise ince kenar ayrintilarini ve gurultuyu daha cok temsil eder. Kod ilk 12 anlamli katsayiyi alir ve ilk katsayinin buyuklugune bolerek olcegi normalize eder.

Gercek ve sanal kisimlar yan yana eklenerek Fourier ozellik vektoru olusur.

### 6.4 El yapimi ozellikler

Yalnizca kontur benzerligi yeterli olmadigi icin su degerler de eklenir:

- 4x4 zoning yogunluklari,
- yatay projeksiyon,
- dikey projeksiyon,
- en/boy orani,
- ters en/boy orani,
- delik sayisi.

Tum degerler birlestirilip vektor uzunlugu 1 olacak sekilde normalize edilir. Buna embedding denir: bir goruntunun sayisal ozeti.

### 6.5 Cosine similarity

Her desteklenen karakter yerel fontla cizilir ve prototip embedding'i uretilir. Yeni karakter embedding'i her prototiple cosine similarity kullanilarak karsilastirilir:

```text
cosine(a, b) = (a . b) / (|a| * |b|)
```

Yonleri ayni olan iki vektorun degeri 1'e yakindir. En yuksek skorlu karakter tahmin edilir; ilk iki skor arasindaki fark da guven kalibrasyonuna katilir. Bu baseline'in guveni bilerek sinirlanir, cunku tek font prototipi gercek belge cesitliligini tam temsil etmez.

## 7. CNN karakter siniflandirici

Kaynaklar:

- `services/ocr/custom_model/char_cnn.py`
- `services/ocr/custom_model/train_char_cnn.py`

CNN, tek bir 32x32 karakter kirpimini sozlukteki siniflardan birine esler.

### 7.1 Convolution

`Conv2d`, kucuk filtreleri goruntu uzerinde gezdirir. Ilk katman kenar ve kisa cizgi gibi basit izleri; sonraki katman bunlarin daha karmasik birlesimlerini ogrenebilir. Filtre katsayilari elle yazilmaz, egitimde hata geriye yayilarak ogrenilir.

### 7.2 ReLU

ReLU negatif aktivasyonlari sifira indirir. Bu dogrusal olmayan adim olmazsa cok katmanli ag tek bir dogrusal donusume denk hale gelir ve karmasik sekil ayrimlarini ogrenemez.

### 7.3 Max pooling

Max pooling kucuk bir bolgedeki en guclu aktivasyonu tutup boyutu yariya indirir. Hesabi azaltir ve karakterin birkac piksel kaymasina karsi tolerans kazandirir.

### 7.4 Flatten ve dense katmanlar

Iki boyutlu ozellik haritalari `Flatten` ile tek vektore cevrilir. `Linear` katmanlari bu vektorden once 128 boyutlu temsil, sonra her karakter icin bir logit uretir. En buyuk logit en olasi siniftir.

### 7.5 Egitim

Egitim dongusu her batch icin:

1. Goruntuleri modelden gecirir.
2. Cross-entropy loss ile tahmin ve dogru sinif farkini hesaplar.
3. `backward()` ile her agirligin hataya etkisini bulur.
4. Optimizer agirliklari kucuk bir adimla gunceller.
5. Validation split'inde agirlik guncellemeden metrik hesaplar.

Checkpoint; model agirliklari, mimari surumu, vocab surumu, seed ve metrikleri birlikte saklar. Degerlendirme top-1, top-3, macro F1, sinif bazli precision/recall/F1 ve confusion matrix uretir.

## 8. CRNN + CTC satir tanima

Kaynaklar:

- `services/ocr/custom_model/crnn.py`
- `services/ocr/custom_model/model.py`
- `services/ocr/custom_model/line_images.py`
- `services/ocr/custom_model/ctc_decoder.py`
- `services/ocr/custom_model/train_crnn.py`

CRNN, satirdaki her karakterin kutusunu onceden bilmek zorunda kalmadan tum satiri okur. `C` convolutional, `R` recurrent, `NN` neural network anlamina gelir.

### 8.1 CNN ozellik cikarici

Satir goruntusu uc convolution katmanindan gecer. Iki pooling adimi yukseklik ve genisligi azaltir. `AdaptiveAvgPool2d((1, None))` yuksekligi 1'e indirirken genislik eksenini korur.

Sonuc artik soldan saga bir ozellik dizisidir. Her zaman adimi satirin belirli yatay bolgesini temsil eder.

Varsayilan v1 mimarisi yatay genisligi iki pooling asamasinda toplam dort kat azaltir. Deneysel `temporal-downsample=2` secenegi ikinci pooling'i yalniz dikey uygular ve CTC'ye iki kat zaman adimi birakir. Bu secenek tekrarlanan rakamlar icin araya blank yerlestirecek daha fazla konum saglar. Ancak pooling anlami degistigi icin eski agirliklar yuklenebilse bile model yeniden adapte edilmelidir. Bes epochluk ilk v2 adaptasyonu v1 sonucunu gecmediginden aktif checkpoint v1 olarak korunmustur.

### 8.2 BiLSTM

Iki katmanli bidirectional LSTM diziyi hem soldan saga hem sagdan sola okur. Bir karakteri tanirken onceki ve sonraki sekilleri birlikte kullanabilir. Ornegin tek bir dikey iz `I`, `ı`, `l` veya `1` olabilir; komsu sekiller baglam saglar.

### 8.3 Sinif logits ve CTC loss

Son `Linear` katman her zaman adiminda tum vocab siniflari icin skor uretir. Bir satir goruntusunun genisligi ile etiket karakter sayisi birebir esit degildir. CTC loss, karakterlerin kesin x koordinatlarini gerektirmeden olasi hizalamalarin toplam olasiligini hesaplar.

Ornek ham CTC yolu:

```text
<blank> T T <blank> O O <blank> P L A A M <blank>
```

Ardisik tekrarlar ve blank kaldirilinca `TOPLAM` elde edilir. Gercek iki ayni karakterin ayrilabilmesi icin aralarinda blank bulunmasi gerekir.

### 8.4 Dinamik genislik ve CTC uzunlugu

`line_images.py` satir yuksekligini normalize eder, en/boy oranini korur ve batch icinde yalnizca gerekli kadar padding uygular. CNN pooling sonrasi her ornegin kullanilabilir zaman adimi hesaplanir. Etiket uzunlugu zaman adimindan buyukse egitim sessizce bozulmaz; acik hata verir.

### 8.5 Greedy ve beam decoding

Greedy decoder her zaman adimindaki en yuksek olasiligi secer. Hizlidir ancak yerel bir karar daha iyi tam diziyi kacirabilir.

Prefix beam search birden fazla olasi metin on ekini birlikte tasir. `beam_width=8`, her adimda en guclu sekiz adayi korur. Bu projede CLI ve belge inference'i icin beam varsayilandir.

Model bazen gerektiğinden fazla blank üretir. Sabit 21 belgeli taramada `blank_penalty=0.5`, `0.0`, `0.3`, `0.4`, `0.6` ve `0.8` seçenekleri arasında temiz CER ve alan doğruluğu dengesi bakımından en iyi sonucu verdi. Bu ayar decoding sırasında blank log olasılığını düşürür; model ağırlıklarını veya ham OCR metninin saklanma ilkesini değiştirmez ve benchmark raporuna yazılır.

### 8.6 Guven puani

Guven, secilen CTC yolundaki olasiliklardan turetilir. Yuksek softmax olasiligi tek basina dogruluk kaniti degildir; son benchmark'ta ortalama guven `0.908506` iken CER `0.396226` olmustur. Bu nedenle guven kalibrasyon bucket'lari ve CER birlikte raporlanir.

## 9. Egitim dongusu ve devam ettirme

`train_crnn.py` deterministik seed, batch size, learning rate, validation CER, early stopping ve resume destegi saglar.

Bir egitim calismasi su sirayla ilerler:

1. Profil ve dataset modu secilir.
2. Gerekirse veri ve manifest uretilir.
3. Manifestteki train/validation kayitlari ayri dataset'lere donusturulur.
4. Model yeni kurulur veya `--resume-from` checkpoint agirliklari yuklenir.
5. Her epoch train batch'lerinde CTC loss optimize edilir.
6. Epoch sonunda validation CER olculur.
7. En dusuk validation CER'e sahip agirlik `model.pt` olarak saklanir.
8. CER belirlenen sabir suresi boyunca iyilesmezse early stopping devreye girer.
9. `metrics.json` ve local model registry kaydi yazilir.

Resume, onceki checkpoint'i silip yeniden baslamak degildir. Ogrenilmis agirliklari alir ve daha dusuk learning rate veya daha uygun veri dagilimiyla egitime devam eder.

`crnn-ctc-v3-length-aware`, batch padding genişliğini gerçek metin uzunluğu sanmaması için her satırın gerçek zaman adımı sayısını çift yönlü LSTM'ye verir. `pack_padded_sequence` yalnız gerçek adımları recurrent encoder'a taşır. `--reuse-existing-dataset` mevcut manifesti değiştirmeden kullanır; manifest yoksa eğitim açık hata verir. `--validation-scope fields`, uzman alan deneylerinde checkpoint'i yalnız alan satırlarının CER değerine göre seçerken tam doğrulama sonucunu ayrıca saklar.

## 10. Tam belge inference akisi

Kaynak: `services/ocr/custom_model/infer.py`

`infer_document()` tam belge icin su adimlari uygular:

1. Checkpoint'i CPU'ya yukler ve metadata'yi okur.
2. Sayfalari custom preprocessing'den gecirir.
3. Her sayfadaki satir kutularini custom segmentasyonla bulur.
4. Gri goruntuden satir kirpimini alir.
5. `prepare_cropped_line_image()` ile normal metin vuruslarini gereksiz buyutmeden 64px tuvale yerlestirir.
6. CRNN log olasiliklarini uretir.
7. Secili CTC decoder ile ham satir metnini ve guveni hesaplar.
8. Cikis bos, dusuk guvenli veya anlamsizsa Fourier yolunu tani olarak dener.
9. Satirlari okuma sirasinda birlestirir.
10. Ham metni korur; extraction icin ayri normalize edilmis metin uretir.
11. Sayfa, satir ve karakter token'larini bbox, kaynak ve guvenle sonuca ekler.

Custom yol Tesseract import etmez veya calistirmaz. Checkpoint yoksa tahmin uydurmak yerine acik hata verir.

## 11. Normalizasyon ve alan cikarma

Kaynaklar:

- `services/ocr/custom_model/normalization.py`
- `packages/shared/src/extraction.ts`
- `apps/api/src/modules/extraction/`

Ham OCR katmani karakterleri oldugu gibi korur. Normalizasyon yalnizca downstream extraction icin kullanilir. Bu ayrim, bir tarih dogrulama kurali uygulandiginda modelin gercekte ne tahmin ettiginin kaybolmamasini saglar.

Alan cikarma satirlarda etiket ve bicim arar: tarih, para, KDV, toplam, belge numarasi, odeme bicimi ve isyeri gibi. Ardindan imkansiz tarih, tutarsiz toplam veya dusuk guven gibi durumlar validation issue olusturur. Dusuk guvenli belge dogrudan kesin gider olarak kabul edilmez; review akisina gider.

## 12. Model registry, API ve worker

Kaynaklar:

- `services/ocr/custom_model/registry.py`
- `services/ocr/app/main.py`
- `apps/api/src/modules/ocr/`
- `apps/api/src/modules/jobs/`

Checkpoint yalnizca bir `.pt` dosyasi degildir. Registry kaydi model kodu, surum, artifact yolu, dataset manifest kimligi, vocab surumu, metrik ve durumu saklar.

API ve worker secilen motoru ayri tutar:

- `CUSTOM_OCR` / geriye uyumlu `CUSTOM_CRNN`: yalnizca proje modeli,
- `TESSERACT`: ayri baseline,
- `ENSEMBLE`: iki sonucu acikca karsilastiran yol.

Worker aktif `CUSTOM_CRNN` artifact'i bulamazsa `CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND` benzeri acik hata uretir. Ensemble, Custom OCR basarisizligini saklamaz.

## 13. UI ve review/duzeltme dongusu

Web arayuzu yuklemede motor secimini, model hazirlik durumunu ve Turkish hata mesajlarini gosterir. Sonuc ekraninda ham ve normalize metin, guven, model surumu, uyari ve token kaniti ayri gorulebilir.

Kullanici metni veya alanlari duzelttiginde onceki tahmin, model surumu, duzeltilmis metin/alanlar, belge turu ve zaman bilgisi kaydedilir. Anonimlestirilmis export, hassas degerleri egitim disari aktariminda korumak icindir. Bu duzeltmeler daha sonra yeni dataset manifestine eklenebilir; canli model kullanici girdisiyle kontrolsuz olarak aninda degismez.

## 14. Benchmark nasil okunur?

Kaynaklar:

- `services/ocr/custom_model/evaluate.py`
- `services/ocr/custom_model/benchmark.py`

Benchmark her belge icin ureticinin gercek etiketini Custom OCR tahminiyle karsilastirir. Tesseract cikisi ground truth olarak kullanilmaz.

- CER: eklenen, silinen ve degisen karakter sayisinin referans karakter sayisina orani.
- WER: ayni hesabin kelime duzeyindeki karsiligi.
- Exact match: tum metnin birebir ayni olma orani.
- Turkish ozel karakter dogrulugu: Turkish karakterlerin ayri olcumu.
- Field extraction accuracy: beklenen isyeri, tarih, belge no, para birimi, ara toplam, KDV, toplam ve odeme biciminin dogru bulunma orani.
- Confusion matrix: hangi referans karakterin neye donustugunu veya silindigini gosterir.
- Confidence calibration: modelin guveni yuksekken gercek hatanin da dusuk olup olmadigini gosterir.
- Latency ve failure: sayfa basi sure ve hata sayisi.

### 14.1 Son olculen durum

En iyi temiz belge/alan dengesini veren length-aware v3 doğrulama sonucu:

```text
best validation CER:                  0.137082
validation WER:                       0.284867
exact line match:                     0.211554
Turkish special character accuracy:  1.000000
```

Aynı checkpoint'in `blank_penalty=0.5` ile 21 belgeli tam doküman benchmark'ı:

```text
average CER:                          0.188838
average WER:                          0.382054
Turkish special character accuracy:  0.966942
field extraction accuracy:           0.357143
clean document CER:                   0.121716
clean field extraction accuracy:      0.500000
```

Bu sonuç önceki checkpoint'lerden daha iyidir. Ancak sözleşmedeki temiz belge CER `<= 0.10` ve temiz alan doğruluğu `>= 0.85` hedeflerini sağlamaz. Beş epoch daha devam edilen checkpoint doğrulama CER'ini `0.128452` değerine düşürmesine rağmen temiz alan doğruluğunu `0.416667` değerine gerilettiği için seçilmedi. Özellikle tarih, belge numarası, ara toplam, KDV ve toplam alanlarında exact değer tanıma yetersizdir. Sistem çalışır durumdadır fakat model production-ready değildir.

## 15. Tekrarlanabilir komutlar

Disk denetimi:

```powershell
Get-PSDrive -PSProvider FileSystem
```

Belge kirpimli veriyle son egitim:

```bash
python -m services.ocr.custom_model.train_crnn --profile local_full --dataset-mode document_lines --data-dir data/generated/local-full-20260616-ocr/crnn-lines-document-crop-preserve --artifact-dir artifacts/models/local-full-20260616-ocr/crnn-document-crop-preserve --seed 20260711 --batch-size 4 --learning-rate 0.0001 --early-stopping-patience 2 --resume-from artifacts/models/local-full-20260616-ocr/crnn-document-aware-continued/model.pt
```

Tam belge benchmark'i:

```bash
python -m services.ocr.custom_model.benchmark --profile local_full --checkpoint artifacts/models/local-full-20260618-ocr/crnn-length-aware-v3/model.pt --output-dir artifacts/benchmarks/local-full-20260618-ocr/crnn-length-aware-v3-final --samples 21 --seed 20260725 --decoder beam --beam-width 8 --blank-penalty 0.5
```

Kod ve entegrasyon testleri:

```bash
python -m unittest discover services/ocr/tests
pnpm test:custom-ocr
pnpm typecheck
pnpm lint
pnpm security:audit
```

## 16. Buradan sonra model nasil iyilestirilir?

Son confusion verisinde cok sayida rakam `<deleted>` olarak gorunmektedir. Alan dogrulugunun dusuk olmasinin ana nedeni, tarih ve tutar satirlarinda rakamlarin eksilmesi ve satirlarin tam korunamamasidir. Sonraki calisma su sirayla yapilmalidir:

1. Benchmark prediction satirlari ile segmentasyon kirpimlarini ayni ornek kimligi altinda incelemek.
2. Hatanin satir kutusundan mi, crop olceginden mi, CTC blank baskinligindan mi geldigini ayirmak.
3. Tarih, belge no ve tutar satirlarini `document_lines` verisinde kontrollu bicimde daha sik uretmek.
4. Rakam ve ayirici karakterler icin CTC hizalama uzunlugunu ve goruntu genisligini denetlemek.
5. Yalnizca validation CER'e bakmak yerine sabit 16 belgeli benchmark'i her anlamli checkpoint'te ayni seed ile calistirmak.
6. Guven kalibrasyonunu duzeltmek; `0.90` guvenli ama yuksek CER'li tahminlerin otomatik kabul edilmesini engellemek.
7. Hedeflere ulasilmadan modeli `READY` teknik artifact olarak kaydetmek ile kullaniciya production-ready gostermek arasindaki farki korumak.

Her degisiklikten sonra ayni benchmark seti, Turkish karakter metrigi ve alan bazli tablo birlikte raporlanmalidir. Yalnizca egitim loss'unun dusmesi veya dar bir unit testin gecmesi tam belge kalitesinin kaniti degildir.

## 17. Sayısal alanlar için segmentasyon destekli Character CNN

CRNN bütün satırı tek seferde okur. Bu yaklaşım sözcük bağlamını öğrenmek için güçlüdür; ancak `860,54`, `20.05.2026` ve `FIS-2026-00001` gibi birbirine benzeyen rakam dizilerinde CTC blank karakteri bazı rakamları silebilir. Son ölçümlerde hata matrisinin büyük bölümü bu rakam silinmelerinden oluştu.

Önce ayrı bir sayısal-alan CRNN denendi. Model sekiz epoch sonunda `0.720895` doğrulama CER değerinde ve `0` exact match oranında kaldı. Decoder blank cezası artırıldığında da kullanılabilir seviyeye gelmedi. Bu nedenle düşük kaliteli model ana çıkarım hattına eklenmedi.

Kabul edilen çözüm şu sırayla çalışır:

1. `segment_words()` alan satırındaki sözcük kutularını bulur.
2. `segment_characters()` bağlı bileşenleri karakterlere ayırır. Geniş ve birbirine değen rakam bileşenleri dikey izdüşüm vadilerinden bölünür; virgül komşu rakama yanlışlıkla aksan olarak eklenmez.
3. Her karakter kutusu oranı korunarak 32x32 Character CNN tuvaline yerleştirilir.
4. CNN merkezi `VOCAB` sınıflarının tamamı üzerinde eğitilmiş checkpoint'i kullanır.
5. Görsel satır türü güvenilir biçimde belirlenmişse aday sınıflar daraltılır. Örneğin miktarda yalnız rakam ve virgül, tarihte rakam ve nokta değerlendirilir.
6. Tam sonuç biçim doğrulamasından geçer. Miktar `rakamlar,iki-rakam`, tarih geçerli `gg.aa.yyyy`, VKN on rakam olmalıdır. Biçim geçmezse yardım reddedilir.
7. CRNN'in ham `text` alanı hiç değiştirilmez. Kabul edilen görsel sonuç yalnız `normalized_text` içinde kullanılır ve her karakter için kutu, güven, model sürümü ve `char_cnn_numeric_constrained` kaynağı yazılır.

Satır kalemlerinde yardım yalnız açık `adet x birim-fiyat TL satır-toplam TL` düzeni bulunduğunda çalışır. Görsel sözcük sayısı ile OCR satır yapısı uyuşmazsa hiçbir değer değiştirilmez. Sistem toplamları aritmetik kullanarak tahmin etmez ve eksik rakam uydurmaz.

Yeniden üretilebilir eğitim komutu:

```bash
python -m services.ocr.custom_model.train_numeric_char_cnn --profile local_full --data-dir data/generated/local-full-20260619-ocr/numeric-field-v1 --artifact-dir artifacts/models/local-full-20260620-ocr/numeric-char-cnn-v2 --base-checkpoint artifacts/models/local-full-20260616-ocr/char-cnn-success/char-cnn.pt --reuse-existing-dataset
```

Son kanıtlar:

```text
Numeric CNN validation character accuracy:       0.999842
Numeric CNN held-out sequence exact match:        0.999170
Clean line raw CER:                               0.117872
Clean line normalized CER:                        0.046937
Clean document raw CER:                           0.121716
Clean document normalized CER:                    0.041434
Clean key-field extraction accuracy:               0.875000
Turkish special-character accuracy:                1.000000 (clean-line validation)
```

Ham ve normalize metriklerin ikisi de raporlanır. Böylece normalize edilmiş ürün çıktısının hedefi geçtiği gösterilirken CRNN'in tek başına olduğundan daha başarılı olduğu iddia edilmez.
