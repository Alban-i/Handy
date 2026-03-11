import { create } from "zustand";

type TranscriptionStatus =
  | "idle"
  | "loading"
  | "loading_model"
  | "transcribing"
  | "done"
  | "error";

interface FileTranscribeState {
  status: TranscriptionStatus;
  result: string | null;
  fileName: string | null;
  isFormatting: boolean;

  setStatus: (status: TranscriptionStatus) => void;
  setResult: (result: string | null) => void;
  setFileName: (fileName: string | null) => void;
  setIsFormatting: (isFormatting: boolean) => void;
  reset: () => void;
}

export const useFileTranscribeStore = create<FileTranscribeState>((set) => ({
  status: "idle",
  result: null,
  fileName: null,
  isFormatting: false,

  setStatus: (status) => set({ status }),
  setResult: (result) => set({ result }),
  setFileName: (fileName) => set({ fileName }),
  setIsFormatting: (isFormatting) => set({ isFormatting }),
  reset: () =>
    set({
      status: "idle",
      result: null,
      fileName: null,
      isFormatting: false,
    }),
}));
