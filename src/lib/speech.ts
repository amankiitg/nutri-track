/**
 * The Web Speech API, behind a small interface.
 *
 * Two awkward things it needs: the constructor is still vendor-prefixed in Chromium
 * (`webkitSpeechRecognition`), and the DOM lib does not declare any of it. Rather
 * than reaching for `any`, the handful of members actually used are declared here, so
 * a typo is a compile error and the unsupported case is a value rather than a throw.
 *
 * Typed dictation is the fallback input for a reason: recognition is unavailable in
 * Firefox and on iOS Safari, so the Type tab has to stand on its own.
 */

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function constructorFor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** False in Firefox and on iOS Safari, where the Type tab is the whole input. */
export function isSpeechRecognitionSupported(): boolean {
  return constructorFor() !== null;
}

export interface DictationHandlers {
  /** Called on every interim and final result, with the whole transcript so far. */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

export interface Dictation {
  stop(): void;
}

/**
 * Starts dictating and returns a handle to stop it.
 *
 * Interim results are passed through as they arrive, so the user sees words appear,
 * and the caller keeps them in an editable field: what is heard is a starting point,
 * not the answer.
 */
export function startDictation(handlers: DictationHandlers): Dictation | null {
  const Constructor = constructorFor();
  if (!Constructor) return null;

  const recognition = new Constructor();
  recognition.lang = typeof navigator === "undefined" ? "en-US" : navigator.language;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let transcript = "";
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternative = result?.[0];
      if (alternative) transcript += `${alternative.transcript} `;
    }
    handlers.onTranscript(transcript.trim());
  };

  recognition.onerror = (event) => {
    handlers.onError(dictationErrorMessage(event.error));
  };

  recognition.onend = () => {
    handlers.onEnd();
  };

  try {
    recognition.start();
  } catch {
    handlers.onError("Dictation could not start. Check the microphone permission.");
    return null;
  }

  return {
    stop: () => recognition.stop(),
  };
}

/** The spec's error codes, in words a person can act on. */
export function dictationErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was refused. Allow it in your browser settings, or type the meal instead.";
    case "no-speech":
      return "I did not catch anything. Try again, or type the meal instead.";
    case "audio-capture":
      return "No microphone was found. Type the meal instead.";
    case "network":
      return "Dictation needs a network connection.";
    case "aborted":
      return "Dictation stopped.";
    default:
      return `Dictation failed (${code}). Type the meal instead.`;
  }
}
