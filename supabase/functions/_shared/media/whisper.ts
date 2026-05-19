// Transcripción de audio con OpenAI Whisper.
// Recibe un Blob (típicamente descargado vía fetchKapsoMedia) y devuelve el texto.

import { openai } from "../lib/openai.ts";
import { log } from "../lib/log.ts";

export async function transcribeAudio(audio: Blob, hintLanguage = "es"): Promise<string> {
  // El SDK de OpenAI acepta un File (Web API). Construimos uno desde el Blob.
  const file = new File([audio], "audio.ogg", { type: audio.type || "audio/ogg" });
  try {
    const res = await openai().audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: hintLanguage,
      // El prompt sesga al modelo hacia el vocabulario del dominio.
      prompt:
        "Negocio de comidas rápidas en Colombia. Vocabulario común: empanada, gaseosa, " +
        "combo, nequi, daviplata, efectivo, transferencia.",
    });
    return res.text.trim();
  } catch (err) {
    log.error("whisper_failed", { err: String(err) });
    throw err;
  }
}
