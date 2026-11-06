# Dafraps

Två egna appar byggda utifrån `Fraps_forklaring.txt` och `DaVinci_Resolve_forklaring.txt`.

| App | Vad den är | Teknik | Mapp |
| --- | --- | --- | --- |
| **Ruta** | Skärminspelare med FPS-overlay, skärmdumpar, benchmark och instant replay | C# / .NET 10, Desktop Duplication, WASAPI, FFmpeg | [ruta/](ruta/README.md) |
| **Kulör** | Videoredigerare med tidslinje, nodbaserad färgkorrigering, mixer och export | Electron, React, WebGL2, FFmpeg | [kulor/](kulor/README.md) |

Båda kräver att `ffmpeg` finns i PATH. Kulör behöver även `ffprobe`.

```bash
cd ruta && dotnet run -c Release
```

```bash
cd kulor && npm install && npm start
```
