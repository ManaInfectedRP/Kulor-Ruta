# Ruta

Skärminspelare för Windows. Idén kommer från Fraps, men tekniken är den moderna vägen från
`Fraps_forklaring.txt`: ingen injicering i spel, utan Desktop Duplication och FFmpeg.

```bash
dotnet run -c Release
```

Kräver .NET 10 och `ffmpeg` i PATH, eller `ffmpeg.exe` bredvid `Ruta.exe`.

## Funktioner

| Funktion | Standardtangent |
| --- | --- |
| Starta/stoppa inspelning | F9 |
| Skärmdump (PNG, JPG, BMP) | F10 |
| Benchmark: frametimes, FPS per sekund och min/max/snitt/1 % låg som CSV | F11 |
| Spara instant replay, 15 s till 5 min bakåt | F8 |
| Visa/dölj FPS-overlay | F7 |

Tangenterna är globala och går att ändra i appen. Utöver det finns val av skärm, 30 till 144 FPS,
muspekare i bild, systemljud och mikrofon (mixat eller ett spår per källa), nedskalning, MP4 eller MKV.

Filerna hamnar i `Videos\Ruta`. Inställningarna ligger i `%APPDATA%\Ruta\settings.json`.

## Så fungerar det

```
Desktop Duplication → capture-tråd (konstant bildfrekvens) → en kö per encoder → skrivtråd → ffmpeg
WASAPI loopback/mikrofon → en kö per ljudkälla → skrivtråd ──────────────────────────────────↗
```

- **Capture** läser alla skärmuppdateringar, vilket också driver FPS-räknaren. Bilden kopieras först
  på GPU:n och läses bara tillbaka vid de tick som behövs.
- **Konverteringen BGRA → NV12 görs i appen** på alla kärnor, med explicit BT.709. Mätt på en FX-8320E
  var FFmpegs swscale flaskhalsen, och så här slipper den köras alls.
- **Ljud och bild hålls ihop genom att strömmen aldrig tappar en bildruta.** Är kön full upprepas en
  bild i stället, så att bilden inte glider mot ljudet.
- **Inspelning sker till MKV** och görs om till MP4 efteråt, så en krasch mitt i inte förstör filen.
- **Instant replay** kodar hela tiden till en ring av korta MPEG-TS-filer på disk. RAM-användningen
  är därför lika låg oavsett buffertens längd.

## Test

`Ruta.exe --selftest <mapp>` kör allt på riktigt mot skrivbordet medan ett litet fönster animeras:
replay, skärmdump, benchmark och inspelning med varje encoder och format, och skriver `report.json`.
Testet spelar in systemljud, och en virtuell mikrofon om det finns någon.

## Kända begränsningar

- **FPS-räknaren mäter skärmuppdateringar, inte spelets egen FPS.** Den slår i skärmens
  uppdateringsfrekvens och sjunker på ett stilla skrivbord. Per-spel-FPS kräver ETW/PresentMon,
  vilket inte är byggt.
- Overlayen syns över fönster- och kantlösa spel, men inte över exklusiv helskärm. Inspelningen
  fungerar ändå.
- Roterade skärmar hanteras inte, och ändrad upplösning avslutar pågående inspelning.
- Ljudkortets och datorns klockor synkas inte mot varandra, så en mycket lång inspelning kan glida
  lite.
- Inställningarna för AMD AMF och Intel Quick Sync är **inte testade**, eftersom maskinen har
  NVIDIA. De erbjuds bara om ett provkodningstest går igenom.
- Mikrofonvägen är bara testad med en virtuell mikrofon.
