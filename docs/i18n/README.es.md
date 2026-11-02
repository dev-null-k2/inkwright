<div align="center">

<img alt="inkwright" src="../media/hero-light.svg" width="480">

**Un cuaderno de escritura a mano que se siente como papel, piensa con cualquier IA y te responde con tinta.**<br>
Local primero · Trae tu propio modelo (o ninguno) · Código abierto · Sin servidores nuestros

[Abrir la app](https://dev-null-k2.github.io/inkwright/app/) · [Descargar para Android](https://github.com/dev-null-k2/inkwright/releases/latest) · [English](../../README.md)

</div>

## Por qué existe

El papel sigue siendo la mejor herramienta para pensar. Pero las apps de notas o se sienten como papel y no entienden nada, o lo entienden todo y se sienten como un formulario. Y la IA en la barra lateral envía tu cuaderno entero al servidor de otro solo para responder una pregunta sobre él.

Inkwright empieza por la pluma. La tinta aparece bajo la punta antes del siguiente fotograma. Tachar una palabra la borra. Se oye la plumilla sobre el papel y, en Android, se siente su grano. Después le da a la página una mente: un agente que lee tu letra, la conecta con todo lo que has escrito, comprueba que no se contradiga y te responde en la página con una tinta claramente distinta de la tuya. Tus notas siguen siendo archivos normales en tus dispositivos y tu almacenamiento. Todo lo que hace la IA es visible, citado y se puede deshacer.

## Qué hace

- **Escribir.** Tinta de baja latencia (punta nativa en Android) y el sonido y el tacto del papel. Tachar para borrar detecta el 99,6 % de los tachones en 580 casos y nunca borró escritura normal. Plumas, caligrafía, lápiz y resaltador, y rellenar y firmar PDF.
- **Pensar.** Funciona con cualquier modelo (OpenAI, Claude, Gemini, Ollama…) o con modelos locales en el propio dispositivo, sin enviar nada. Rodea una pregunta y la IA responde al lado, con letra manuscrita. Dibuja cajas y flechas y pulsa «Ejecutar». Las clases se transcriben en el dispositivo; toca la tinta para oír lo que se decía.
- **Recordar.** Una wiki personal compilada a partir de tus notas: cada frase se marca como «extraída», «inferida» o «ambigua» y señala su origen exacto. Además, un detector de contradicciones, tarjetas FSRS, enlaces bidireccionales, notas diarias, un grafo 3D e importación y exportación con Obsidian.
- **Confianza.** Cada llamada a la IA pasa por un único punto de control:
  - enruta según tu política;
  - oculta los datos personales;
  - comprime el contexto (unos 80 % menos de tokens);
  - mide el coste en dinero;
  - deja un registro de auditoría firmado.

  Puedes marcar cuadernos como «nunca sale de este dispositivo».
- **Para desarrolladores.** `[[code:ruta#función]]` enlaza una nota con tu código y avisa cuando ese código cambia. También incluye:
  - diagramas verificados y runbooks ejecutables;
  - MCP, A2A, una API REST (OpenAPI 3.1) y webhooks;
  - un SDK y una CLI.

## Empezar

```sh
git clone https://github.com/dev-null-k2/inkwright && cd inkwright
npm install
npm run dev
```

Licencia: Apache-2.0. Documentación completa en el [README](../../README.md) en inglés.
