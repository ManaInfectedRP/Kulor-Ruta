# Kulör

Videoredigerare med nodbaserad färgkorrigering, byggd efter stegen i `DaVinci_Resolve_forklaring.txt`.

```bash
npm install
```

```bash
npm start
```

Kräver `ffmpeg` och `ffprobe` i PATH. `npm run dev` ger snabb omladdning av gränssnittet.

## Sidor

- **Media:** import med dra-och-släpp, metadata, miniatyrer och projektinställningar. Filer som
  webbmotorn inte kan spela, till exempel HEVC eller MKV, får automatiskt en proxy.
- **Klipp:** flera spår, flytta, trimma, dela, ta bort med stängd lucka, fästning, länkat ljud,
  vågformer. Transform med nyckelbilder, toningar och korstoning.
- **Titlar:** text som egna klipp med förval, typsnitt, kontur, skugga, bakgrund och färdiga
  animationer. Dra texten direkt i bilden. Titlar kan färgkorrigeras som vilket klipp som helst.
- **Färg:** seriell nodkedja med Lift, Gamma, Gain, Offset, kontrast, mättnad, nyans, temperatur,
  kurvor, HSL-kvalificerare och maskfönster. Vågform, RGB-parad, vektorskop och histogram.
- **Ljud:** mixer med fader, panorering, mute, solo och nivåmätare.
- **Leverera:** H.264, H.265, ProRes 422 HQ och DNxHR HQ, hela tidslinjen eller mellan I och O.

Kortkommandon:

| Tangent | Funktion |
| --- | --- |
| Mellanslag / K | Spela, pausa / stoppa |
| J / L | Spela bakåt / framåt, tryck igen för dubbel fart |
| ← → | En bildruta, med Shift tio |
| Ctrl+B | Dela vid spelhuvudet |
| A / B | Markera / klippverktyg |
| Delete / Shift+Delete | Ta bort / ta bort och stäng luckan |
| I / O / X | In- och utpunkt / rensa dem |
| N | Fästning av och på |
| + / − | Zooma tidslinjen, även Ctrl+scroll |
| Ctrl+Z / Y / S / O / I | Ångra / gör om / spara / öppna / importera |

## Så fungerar det

Hela designen vilar på **en enda kompositor** ([compositor.ts](src/engine/compositor.ts)). Både
förhandsvisning och export ritar genom den, så det som syns när man färgsätter är per konstruktion
det som hamnar i filen.

```
Förhandsvisning: <video> eller proxy ────────→ kompositor → skärmen
Export:          ffmpeg (original, YUV) ──────→ kompositor → NV12 → ffmpeg → fil
                 ffmpeg (ljudmix till WAV) ───────────────────────────↗
```

- Kompositorn arbetar i 16-bitars flyttal, så en nod kan trycka värden över vitt och en senare ta
  tillbaka dem utan klippning. Hela färgkedjan är en fragment-shader.
- Ljudklockan styr uppspelningen: bilden följer ljudet.
- Tidslinjen räknar i hela bildrutor, aldrig i sekunder, så upprepade redigeringar inte kan ge drift.
- Export gör färgkonverteringen på GPU:n, i båda riktningarna, och stegen överlappar varandra.
  Mätt på en FX-8320E gav det 27 fps i 1080p, mot 7,5 fps med RGB genom swscale.
- All redigeringslogik är rena funktioner i [src/core](src/core), vilket gör ångra trivialt och
  logiken testbar utan Electron.

## Test

```bash
npm test
```

Enhetstester av tidslinje, nyckelbilder, titlar, färgmatematik och ljudmix.

```bash
npm run build && node test/e2e.mjs
```

End-to-end i riktig Electron med genererad media och riktiga mus- och tangenthändelser. Testet
kontrollerar bland annat att exporten är exakt på rätt bildruta och stämmer med förhandsvisningen,
även för nyckelbilder, korstoning och titlar, samt alla format och avbruten export.

## Kända begränsningar

- **Nodbaserad compositing (Fusion), AI-funktioner och samarbete finns inte.** De ligger under
  "avancerade delar" i planen. Inte heller hastighetsändring, EQ eller parallella färgnoder.
- Färgen arbetar direkt i Rec.709-värden, utan OpenColorIO eller ACES. HDR stöds inte.
- Export läser källan i 8 bitar, så 10-bitsmaterial tappar precision även till ProRes.
- Korstoning gäller bilden. Ljudet klipps hårt, men kan tonas i och ut per klipp.
- Bildfrekvensen låses när det finns klipp, eftersom tidslinjen räknar i bildrutor.
- Förhandsvisning av proxy visar en nedskalad version av originalet. Export använder alltid originalet.
- Maskfönster justeras med värden, det går inte att dra dem direkt i bilden.
- Titlar radbryts inte automatiskt och kan inte ha flera stilar i samma klipp. Typsnitten är en fast
  lista över vanliga Windows-typsnitt, och ett projekt som flyttas till en dator utan dem ser annorlunda ut.
