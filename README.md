# Şirket

CEO'na yaz, gerisini ekip halletsin.

Telefonda çalışan kişisel bir "şirket" uygulaması. Claude CEO mesajını alır, işi müdürlere dağıtır, sonuçları denetler ve tek cevap yazar.

## Ekip

| Rol | Sağlayıcı | Model |
|---|---|---|
| CEO | Anthropic | claude-fable-5-2 |
| Araştırma Müdürü | Google | gemini-3.7-flash + Google Search |
| İçerik ve Yazı Müdürü | OpenAI | gpt-6-sol |
| Teknik Müdür | Anthropic | claude-opus-5-5 |
| Finans ve Analiz Müdürü | OpenAI | gpt-6-sol (reasoning high) |
| Grok | xAI | grok-4.7 + web ve X araması |
| Görsel Tasarım | OpenAI | gpt-image-2.6-sunburst |
| Görsel Stüdyo | Google | gemini-3-pro-image |

Modeller, talimatlar ve açık/kapalı durumu uygulamadaki **Ekip** sekmesinden değiştirilir (veritabanındaki `agents` tablosu).

## Ofis sekmesi

Müdürler masalarında oturur. CEO bir görev verdiğinde dosyayı elinde ilgili masaya götürür, iş bitince sonucu alır ve sıradaki kişiye ya da kendi masasına taşır. Sahne canlı görev kayıtlarından (`tasks`, `runs`, `messages`) beslenir; bir masaya dokununca o müdürün ayarları açılır.

## Yapı

- `docs/` : PWA (GitHub Pages buradan yayınlanır). Tek dosya `index.html`, `manifest.json`, `sw.js`, ikonlar.
- `supabase/functions/ceo/index.ts` : CEO beyni (Supabase Edge Function).
- Supabase projesi: `sirket-ceo` (eu-central-1)

### Akış

1. Uygulama `send` ile mesajı yollar. Fonksiyon mesajı ve bir `run` kaydını yazar.
2. `step`: Claude CEO çalışır. Müdür gerekiyorsa her biri için `tasks` satırı açılır ve hepsi paralel `work` çağrısıyla başlar.
3. `work`: Müdür kendi API'sini çağırır, sonucu (ve görselleri `ceo-files` deposuna) yazar. Son biten müdür CEO'yu tekrar uyandırır.
4. CEO sonuçları inceler; ya yeni görev verir ya da final cevabı `messages` tablosuna yazar.
5. Uygulama tüm bunları Supabase Realtime ile canlı gösterir.

Her adım ayrı fonksiyon çağrısı olduğu için uzun işler zaman sınırına takılmaz. Bir işte en fazla 8 CEO adımı vardır.

## Kurulum

1. Supabase panelinde **Edge Functions > Secrets** bölümüne ekle:
   - `ANTHROPIC_API_KEY` (zorunlu, CEO için)
   - `OPENAI_API_KEY`
   - `GEMINI_API_KEY` (Google AI Studio)
   - `XAI_API_KEY`
2. Uygulamayı Safari'de aç, **İlk kurulum: hesap oluştur** ile hesabını aç. İlk açılan hesap şirketin sahibi olur, başka kimse veriye erişemez.
3. E-postadaki onay linkine tıkla, sonra uygulamada giriş yap.
4. Safari > Paylaş > **Ana Ekrana Ekle**.
5. İstersen Supabase panelinde **Authentication > Sign In / Providers** altından yeni kayıtları kapat.

## Güvenlik

- API anahtarları sadece Supabase'te durur, telefona veya bu repoya hiç gelmez.
- Repodaki `sb_publishable_...` anahtarı herkese açık olacak şekilde tasarlanmıştır; veriler RLS ile sadece sahibe açıktır.
- Müdürler dış dünyada işlem yapmaz (mail atmaz, paylaşım yapmaz); sadece metin ve görsel üretir.
