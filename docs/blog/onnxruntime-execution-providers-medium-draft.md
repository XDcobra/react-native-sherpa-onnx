# ONNX Runtime Execution Providers: was sie sind, wie sie intern arbeiten und wann sich welcher EP lohnt

ONNX Runtime ist mehr als ein schneller CPU-Interpreter fuer ONNX-Modelle. Der eigentliche Hebel fuer Performance sind die Execution Providers, kurz EPs. Sie entscheiden, welche Teile eines Modells auf welcher Hardware laufen, wie die Graphen partitioniert werden, welche Backends kompiliert werden und ob Ergebnisse direkt im Speicher, ueber ein Device oder ueber einen spezialisierten Compiler laufen.

Dieser Beitrag erklaert zuerst ONNX Runtime selbst, dann die wichtigsten Execution Providers, ihren internen Aufbau und am Ende eine praxisnahe Vergleichstabelle mit dokumentierten Performance-Hinweisen und Quellen.

> Hinweis: Die Performance-Werte unten sind absichtlich nicht als streng fairer 1:1-Benchmark zu verstehen. ONNX Runtime und die EP-Hersteller dokumentieren je nach Provider unterschiedliche Metriken: mal Session-Init-Zeit, mal relativen Speedup, mal optimierte Datenpfade. Ich kennzeichne das in der Tabelle explizit.

## Was ist ONNX Runtime?

ONNX Runtime ist eine Inferenz-Engine fuer ONNX-Modelle. Sie nimmt ein ONNX-Graphmodell, optimiert es und fuehrt es auf einer passenden Ausfuehrungsumgebung aus. Diese Umgebung kann CPU, GPU, NPU, DSP oder ein anderes spezialisiertes Backend sein.

Die Kernidee ist simpel: ONNX Runtime macht nicht alles selbst, sondern delegiert Teile des Graphen an ein Backend, das die jeweilige Hardware besser ausnutzen kann. Genau dafuer gibt es Execution Providers.

## Was sind Execution Providers?

Ein Execution Provider ist ein Backend fuer ONNX Runtime. Beispiele sind:

- CPU
- oneDNN
- XNNPACK
- CUDA
- TensorRT
- TensorRT RTX
- DirectML
- OpenVINO
- NNAPI
- Core ML
- QNN
- ROCm
- MIGraphX
- Vitis AI
- Azure

Die offizielle Uebersichtsseite listet noch weitere EPs, darunter Preview- und Community-Varianten wie WebGPU, WebNN, ArmNN, ACL, Rockchip NPU oder CANN. In diesem Beitrag fokussiere ich die in der Praxis wichtigsten und am besten dokumentierten Provider.

## Wie ONNX Runtime intern mit EPs arbeitet

Der technische Ablauf ist immer aehnlich:

1. ONNX Runtime analysiert den gesamten Graphen.
2. Jeder EP meldet per `GetCapability()` oder einem aehnlichen Mechanismus, welche Nodes oder Subgraphs er uebernehmen kann.
3. ONNX Runtime partitioniert den Graphen.
4. Die passenden Subgraphs werden an den EP uebergeben.
5. Der EP laesst daraus direktes Device-Compute, einen kompilierten Kontext oder native Kernels entstehen.
6. Nicht unterstuetzte Teile fallen auf andere EPs oder auf CPU zurueck.

Wichtig ist dabei: Ein EP ist selten nur ein anderer Kernel. Oft ist er ein Compiler, ein Layout-Transformer, ein Cache-System und ein Runtime-Adapter in einem.

## CPU Execution Provider

Der CPU Execution Provider ist die Basis von ONNX Runtime. Wenn kein anderer EP greift, laeuft das Modell hier.

Intern arbeitet der CPU EP direkt mit nativen ONNX Runtime Kerneln. Er ist der Referenzpfad fuer Korrektheit und ein vernuenftiger Default fuer Portabilitaet. Fast alle anderen EPs nutzen CPU-Fallback fuer nicht unterstuetzte Operatoren.

Der CPU EP ist deshalb wichtig aus zwei Gruenden:

- Er definiert das Referenzverhalten.
- Er uebernimmt Rest-Graphen, wenn ein spezialisierter EP einen Node nicht abdecken kann.

Fuer moderne CPU-Deployments ist der CPU EP oft schon gut, aber nicht immer optimal. Hier kommen oneDNN und XNNPACK ins Spiel.

## oneDNN Execution Provider

oneDNN ist der Intel-nahe CPU- und CPU-Vectorized-Provider. Er ist fuer Intel-Architekturen optimiert und nutzt blocked layouts, vectorisierte Primitive und Threading.

Intern ist oneDNN interessant, weil ONNX Runtime bei `GetCapability()` nicht einfach nur einzelne Ops weiterreicht, sondern eigene Subgraph-IRs bildet. oneDNN erzeugt daraus interne Primitive wie Conv, Pool oder BatchNorm und verknuepft sie zu einem Subgraph, der dann als Block ausgefuehrt wird.

Der Performance-Hebel kommt vor allem aus zwei Dingen:

- Layout-Optimierung: Daten werden in blocked layouts gehalten, damit sie besser in SIMD-Register und Cache passen.
- Subgraph-Fusion: mehrere Ops werden zu einem laeufigeren internen Ablauf zusammengezogen.

oneDNN ist daher oft die richtige Wahl, wenn du auf Intel-Servern oder Intel-Client-CPUs maximale CPU-Performance willst.

## XNNPACK Execution Provider

XNNPACK ist ein hochoptimierter CPU-Provider fuer Arm, x86 und WebAssembly. Er ist besonders stark bei mobilen und edge-nahen Workloads.

Intern setzt XNNPACK auf spezialisierte Floating-Point-Kernels und einen eigenen Threadpool. Die ONNX Runtime-Doku weist sogar explizit darauf hin, dass XNNPACK seinen eigenen Threadpool hat und man die ORT-Intra-Op-Threading-Strategie darauf abstimmen sollte, um Contentention zu vermeiden.

Das macht XNNPACK besonders passend fuer:

- mobile Apps
- kleine bis mittlere CNNs
- CPU-only Inferenz mit guter Energieeffizienz

Anders gesagt: Wenn du keinen GPU- oder NPU-Backed willst, aber moeglichst effiziente CPU-Kernels, ist XNNPACK oft die bessere Wahl als der nackte CPU EP.

## CUDA Execution Provider

CUDA ist der NVIDIA-GPU-EP fuer ONNX Runtime. Er verwendet CUDA- und cuDNN-Kerne und fuehrt Modellteile direkt auf NVIDIA-GPUs aus.

Intern partitioniert ONNX Runtime den Graphen und gibt passende Subgraphs an den CUDA EP. Dieser uebersetzt die Ausfuehrung in GPU-Kerne, nutzt cuDNN fuer Convolutions und kann mit Optionen wie `use_tf32`, `cudnn_conv_use_max_workspace` oder `enable_cuda_graph` deutlich schneller werden.

Zwei Details sind besonders wichtig:

- `I/O Binding` reduziert Kopierueberkopf zwischen Host und Device.
- `CUDA Graphs` senken CPU-Launch-Overhead bei vielen kleinen Layern oder oft wiederholten Runs.

CUDA ist meist die Standardwahl, wenn du auf NVIDIA-Hardware breite Kompatibilitaet und gute Performance brauchst, aber nicht die harte Engine-Optimierung von TensorRT willst.

## TensorRT Execution Provider

TensorRT ist der spezialisierte NVIDIA-Compiler-EP. Er ist in vielen Faellen der schnellste Weg auf NVIDIA-GPUs, weil er nicht nur Kernels ausfuehrt, sondern ganze Subgraphs in optimierte Engines kompiliert.

Intern passiert hier deutlich mehr als bei CUDA:

- ONNX Runtime partitioniert den Graphen.
- TensorRT baut daraus eine Engine.
- Diese Engine wird getuned, ggf. mit FP16 oder INT8.
- Optional wird sie als Cache, Timing Cache oder als eingebettetes EPContext-Modell gespeichert.

Das ist der Grund, warum TensorRT oft eine hoehere Startzeit hat als CUDA, aber deutlich bessere Laufzeit liefern kann.

Die ONNX Runtime-Doku zeigt auch klar, dass Caches den Session-Start massiv verkuerzen koennen. Fuer ein SD-UNet-Beispiel werden folgende Werte dokumentiert:

- ohne Cache: 384 Sekunden
- Timing Cache: 42 Sekunden
- Engine Cache: 9 Sekunden
- Embedded Engine: 1.9 Sekunden

Das ist kein allgemeiner Benchmark fuer alle Modelle, aber ein sehr gutes Signal, wie stark TensorRT bei Compilierungs- und Cache-Strategien skaliert.

## TensorRT RTX Execution Provider

TensorRT RTX ist die neuere NVIDIA-Variante fuer RTX-orientierte Workloads. In den ONNX Runtime Release Notes wird er als EP fuer RTX-GPUs beschrieben, der TensorRT fuer optimierte Performance nutzt.

Praktisch betrachtet ist er ein spezialisierterer NVIDIA-Pfad fuer neuere RTX-Hardware. Der interessante Punkt ist nicht nur rohe GPU-Leistung, sondern auch moderner Engine- und Cache-Stack fuer RTX-Zielsysteme.

Wenn du NVIDIA-Hardware aelterer und neuerer Generationen unterstuetzen musst, ist das ein EP, den man beobachten sollte. Fuer einen Medium-Artikel reicht hier eine kurze Einordnung, weil der Provider sich noch schneller entwickelt als die etablierten Standards CUDA und TensorRT.

## DirectML Execution Provider

DirectML ist der Windows-GPU-EP von ONNX Runtime. Er nutzt DirectX 12 und spricht viele unterschiedliche GPUs an, ohne vendor-spezifische Treiberstacks vorauszusetzen.

Intern ist DirectML eher ein generischer Accelerator als ein hochspezialisierter Compiler wie TensorRT. ONNX Runtime empfiehlt, die Shapes moeglichst zur Session-Erzeugung zu kennen, weil dann mehr Optimierungen passieren koennen: Constant Folding, Preprocessing von Gewichten und effizientere Layout-Entscheidungen.

Wichtig ist auch die Betriebslogik:

- DirectML mag statische Shapes.
- Memory Pattern und Parallel Execution muessen deaktiviert werden.
- Das EP ist auf Single-Run-Korrektheit und robuste Windows-Hardwareabdeckung ausgelegt.

Wenn du unter Windows breite Hardware-Kompatibilitaet mit solider GPU-Beschleunigung willst, ist DirectML oft die pragmatische Wahl.

## OpenVINO Execution Provider

OpenVINO ist Intels EP fuer CPU, GPU und NPU auf Intel-Hardware.

Intern macht OpenVINO eine Mischung aus Graph-Optimierung, Device-Selection und Backend-Kompilierung. Die Doku beschreibt unter anderem AUTO, HETERO und MULTI Modi. Das bedeutet:

- AUTO waehlt das beste Device automatisch.
- HETERO verteilt Workloads ueber mehrere Devices.
- MULTI nutzt mehrere Devices parallel fuer Durchsatz.

OpenVINO ist stark, wenn du Intel-CPUs, iGPUs oder NPUs optimal ausnutzen willst. Die Doku nennt ausserdem einen klaren Performance-Hinweis: FP16 liefert auf GPU/NPU generell etwa 2x bessere Performance mit minimalem Accuracy-Verlust.

## NNAPI Execution Provider

NNAPI ist der Android-Hardware-EP fuer ONNX Runtime. Er gibt Modelle an das Android Neural Networks API weiter, das je nach Device CPU, GPU oder spezialisierte Beschleuniger anspricht.

Intern ist NNAPI stark ueber Device-Dispatch und Op-Unterstuetzung definiert. ONNX Runtime partitioniert den Graphen, und NNAPI uebernimmt die teile, die das Android-Backend gerade unterstuetzt. Nicht unterstuetzte Op-Pfade koennen auf ORT oder CPU fallen.

Die relevanten Performance-Hebel sind:

- FP16-Relaxation kann helfen.
- NCHW ist oft langsamer als NHWC.
- CPU-Fallback sollte bewusst kontrolliert werden.

NNAPI ist der natuerliche Standard-EP fuer Android, wenn du ohne proprietaere Hardware-API maximale Reichweite willst.

## Core ML Execution Provider

Core ML ist der Apple-EP fuer iOS und macOS. ONNX Runtime nutzt ihn, um Modelle auf CPU, GPU und vor allem Apple Neural Engine auszufuehren.

Intern wird der Graph in Core-ML-kompatible Teilgraphen uebersetzt. Dabei spielt das Modellformat eine Rolle: NeuralNetwork oder MLProgram. Ausserdem ist Caching wichtig, weil die Core-ML-Kompilierung fuer komplexe Modelle teuer sein kann.

Die Doku macht zwei Dinge klar:

- Statische Shapes sind fuer Performance wichtig.
- Ein Cache-Verzeichnis kann teure Re-Compilation vermeiden.

Core ML ist deshalb die erste Wahl fuer Apple-Plattformen, wenn du moeglichst tief in das Apple-Accelerator-Stack gehen willst.

## QNN Execution Provider

QNN ist der Qualcomm-EP fuer Android und Windows auf Snapdragon-Hardware.

Intern baut QNN aus dem ONNX-Modell einen QNN-Graphen, der dann auf Backend-Libraries wie HTP oder GPU ausgefuehrt wird. Das ist mehr als nur Kernel-Offload: Das Modell muss oft quantisiert werden, das Backend braucht passende Runtime-Libraries, und fuer gute Session-Startzeiten gibt es Kontext-Cache-Mechanismen.

Die wichtigsten Punkte aus der Doku:

- HTP ist der Standardpfad und offlaet Compute auf die NPU.
- HTP erfordert quantisierte Modelle.
- GPU-Backend kann FP16-Modelle schneller als FP32 ausfuehren.
- Kontext-Binaries koennen Session-Startkosten deutlich senken.
- QNN bietet Profiling bis hin zu Optrace/QHAS.

QNN ist deshalb die relevante Wahl fuer Snapdragon-basierte Mobile- und Windows-Devices, wenn NPU-Performance das Ziel ist.

## ROCm Execution Provider

ROCm ist der AMD-GPU-EP, wurde aber laut ONNX Runtime inzwischen aus dem Source Tree entfernt und soll durch MIGraphX ersetzt werden.

Historisch war ROCm der direkte AMD-GPU-Pfad. Fuer neue Projekte sollte man ihn nicht mehr als Ziel setzen, sondern MIGraphX evaluieren.

Der Punkt im Blog ist also weniger Performance als Migrationshinweis: ROCm ist Legacy, MIGraphX ist der aktuelle AMD-Weg.

## MIGraphX Execution Provider

MIGraphX ist AMDs Graph-Optimierungs-Engine fuer ONNX Runtime auf AMD-GPUs.

Intern kompiliert MIGraphX den Graphen in eine Form, die fuer AMD-Hardware passend ist. ONNX Runtime bietet Session- und Environment-Optionen wie FP16, BF16, INT8 und Caching. Auch ein kompiliertes Modell kann gespeichert und wieder geladen werden.

Das macht MIGraphX interessant fuer:

- AMD-GPUs in Rechenzentren
- AMD-Workstations
- Szenarien mit wiederholter Session-Erstellung und Cache-Nutzung

Wenn du auf AMD gehst, ist MIGraphX inzwischen der relevante Performance-Provider.

## Vitis AI Execution Provider

Vitis AI ist der AMD-EP fuer Ryzen AI, Adaptable SoCs und weitere AMD-NPU-Zielsysteme.

Intern kompiliert der EP Graph und Gewichte zu einem mikro-codierten Executable, das auf dem Accelerator laeuft. Das ist ein klassischer Compile-Ahead-of-Time-Ansatz mit Cache fuer Folgeruns.

Die Doku betont, dass die erste Session-Kompilierung Minuten dauern kann, der Cache aber spaetere Runs deutlich beschleunigt. Ausserdem werden INT8 und BF16 als wichtige Quantisierungswege genannt.

Vitis AI ist deshalb die relevante Option, wenn du auf AMD-NPU-Targets arbeitest.

## Azure Execution Provider

Azure EP ist ein Sonderfall: Er laesst ONNX Runtime auf einen entfernten Azure-Endpunkt ausweichen.

Das ist kein klassischer lokale Hardware-EP, sondern ein Hybrid- oder Remote-Inferenzpfad. ONNX Runtime beschreibt zwei Nutzungsarten: Edge und Azure nebeneinander oder ein gemergtes Hybridmodell.

Fuer einen Performance-Artikel ist Azure EP interessant, weil er zeigt, dass EPs nicht nur Hardware-Beschleuniger sind, sondern auch Orchestrierungsmechanismen zwischen Edge und Cloud.

## Weitere Execution Providers

Die ONNX Runtime-UEbersicht nennt noch weitere EPs wie WebGPU, WebNN, ArmNN, ACL, Rockchip NPU, CANN oder Community-Plugins. Viele davon sind Preview, Plattform-spezifisch oder stark im Wandel.

Fuer einen ersten Medium-Artikel wuerde ich sie eher als Ausblick oder Sammelabschnitt fuehren, nicht als Hauptteil.

## Performance-Vergleich der wichtigsten EPs

Die folgende Tabelle ist absichtlich eine Vergleichstabelle mit dokumentierten Leistungsindikatoren, nicht ein einheitlicher Labor-Benchmark. Die Angaben stammen aus den jeweiligen offiziellen ONNX-Runtime-Dokumenten oder Release Notes.

| Execution Provider | Plattform | Dokumentierter Performance-Hinweis | Quelle |
| --- | --- | --- | --- |
| TensorRT | NVIDIA GPU | Session-Init fuer SD UNet: 384 s ohne Cache, 42 s mit Timing Cache, 9 s mit Engine Cache, 1.9 s mit Embedded Engine | [TensorRT EP Caches](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#tensorrt-ep-caches) |
| OpenVINO | Intel CPU/GPU/NPU | FP16 liefert auf GPU/NPU typischerweise etwa 2x bessere Performance mit minimalem Accuracy-Verlust | [OpenVINO EP](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html) |
| CUDA | NVIDIA GPU | CUDA Graphs senken CPU-Launch-Overhead; TF32 ist auf Ampere standardmaessig aktiv und beschleunigt bestimmte FP32-Workloads | [CUDA EP](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) |
| QNN | Qualcomm Snapdragon | HTP ist der Standardpfad auf die NPU; Context-Cache senkt Session-Startkosten; GPU-Backend laeuft mit 16-bit oft schneller als mit 32-bit | [QNN EP](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html) |
| Core ML | Apple iOS/macOS | Statische Shapes und ModelCacheDirectory reduzieren teure Core-ML-Kompilierung; MLComputeUnits kann ANE/GPU aktivieren | [CoreML EP](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html) |
| NNAPI | Android | FP16-Relaxation kann Performance verbessern; NHWC ist oft schneller als NCHW | [NNAPI EP](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html) |
| DirectML | Windows GPU | Statische Shapes verbessern Constant Folding, Preprocessing und Layout-Optimierung; keine universelle Zahl, sondern stark modellabhaengig | [DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) |
| XNNPACK | CPU, Android, iOS, WebAssembly | Separate Threadpool-Strategie und optimierte Float-Kernels fuer Arm/x86/WASM | [XNNPACK EP](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html) |
| oneDNN | Intel CPU | Blocked Layouts und vectorisierte Primitives fuer CPU-optimierte Subgraphs | [oneDNN EP](https://onnxruntime.ai/docs/execution-providers/oneDNN-ExecutionProvider.html) |
| MIGraphX | AMD GPU | Kompiliert Graphen zu AMD-spezifischen Ausfuehrungsformen; Support fuer FP16/BF16/INT8 und Model-Cache | [MIGraphX EP](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html) |
| Vitis AI | AMD NPU / SoC | Erstkompilierung kann Minuten dauern, Folgeruns profitieren vom Cache des mikro-codierten Executables | [Vitis AI EP](https://onnxruntime.ai/docs/execution-providers/Vitis-AI-ExecutionProvider.html) |
| ROCm | AMD GPU | Legacy, von ONNX Runtime entfernt; Migration zu MIGraphX empfohlen | [ROCm EP](https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html) |
| TensorRT RTX | NVIDIA RTX GPU | RTX-spezifischer TensorRT-Pfad; Engine- und Cache-Verhalten folgt dem TensorRT-Prinzip | [ONNX Runtime Releases](https://github.com/microsoft/onnxruntime/releases) |

## Was man daraus praktisch mitnimmt

Wenn du maximale NVIDIA-Performance willst, beginnt die Reihenfolge meist bei CUDA und endet oft bei TensorRT. Wenn du auf Apple baust, ist Core ML die native Wahl. Auf Android ist NNAPI die breite Standardoption, QNN die Hardware-nahe Qualcomm-Option. Auf Intel ist OpenVINO meist die erste Wahl, auf AMD eher MIGraphX oder Vitis AI je nach Zielhardware. Fuer reine CPU-Deployments sind oneDNN und XNNPACK die relevanten Optimierer.

Der wichtigste technische Punkt ist aber ueberall derselbe: Der EP entscheidet nicht nur, wo gerechnet wird, sondern auch, wie der Graph zerlegt, kompiliert, gecacht und gespeichert wird. Genau deshalb unterscheiden sich EPs in Startzeit, Laufzeit, Speicherbedarf und Portabilitaet so deutlich.

## VoiceLab-App

Die hier beschriebenen Execution Providers lassen sich in der Praxis in unserer VoiceLab-App nutzen. Je nach Device und Plattform kann die App den passenden Provider waehlen und so je nach Hardware unterschiedliche Beschleuniger nutzen.

[Play Store Link](https://example.com/play-store) | [App Store Link](https://example.com/app-store)

## Quellen

- [ONNX Runtime Execution Providers](https://onnxruntime.ai/docs/execution-providers/)
- [CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
- [TensorRT Execution Provider](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html)
- [OpenVINO Execution Provider](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html)
- [DirectML Execution Provider](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
- [NNAPI Execution Provider](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html)
- [CoreML Execution Provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [QNN Execution Provider](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)
- [XNNPACK Execution Provider](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html)
- [oneDNN Execution Provider](https://onnxruntime.ai/docs/execution-providers/oneDNN-ExecutionProvider.html)
- [ROCm Execution Provider](https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html)
- [MIGraphX Execution Provider](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html)
- [Vitis AI Execution Provider](https://onnxruntime.ai/docs/execution-providers/Vitis-AI-ExecutionProvider.html)
- [EP Context Design](https://onnxruntime.ai/docs/execution-providers/EP-Context-Design.html)
- [ONNX Runtime Performance Tuning](https://onnxruntime.ai/docs/performance/tune-performance/)
- [Quantize ONNX Models](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
