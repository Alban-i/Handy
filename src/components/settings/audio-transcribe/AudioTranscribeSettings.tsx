import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FileAudio, Upload, Copy, Check, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup } from "../../ui";
import { useFileTranscribeStore } from "@/stores/fileTranscribeStore";

const ACCEPTED_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "aac", "m4a"];

export const AudioTranscribeSettings = () => {
  const { t } = useTranslation();
  const {
    status,
    result,
    fileName,
    isFormatting,
    setStatus,
    setResult,
    setFileName,
    setIsFormatting,
  } = useFileTranscribeStore();

  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const transcribeFile = useCallback(
    async (filePath: string) => {
      setStatus("loading");
      setResult(null);
      setFileName(null);

      const unlisten = await listen<string>(
        "file-transcription-progress",
        (event) => {
          setStatus(event.payload as "loading" | "loading_model" | "transcribing" | "done" | "error");
        },
      );

      try {
        const response = await invoke<{
          text: string;
          file_name: string;
        }>("transcribe_audio_file", { filePath });

        setResult(response.text);
        setFileName(response.file_name);
        setStatus("done");
      } catch (error) {
        setStatus("error");
        toast.error(
          t("audioTranscribe.error", {
            error: String(error),
          }),
        );
      } finally {
        unlisten();
      }
    },
    [t, setStatus, setResult, setFileName],
  );

  const handleFormatText = useCallback(async () => {
    if (!result) return;

    setIsFormatting(true);
    try {
      const formatted = await invoke<string>("format_transcription_text", {
        text: result,
      });
      setResult(formatted);
      toast.success(t("audioTranscribe.formatSuccess"));
    } catch (error) {
      toast.error(
        t("audioTranscribe.formatError", {
          error: String(error),
        }),
      );
    } finally {
      setIsFormatting(false);
    }
  }, [result, t, setIsFormatting, setResult]);

  const handleFileSelect = useCallback(async () => {
    const filePath = await open({
      multiple: false,
      filters: [
        {
          name: "Audio",
          extensions: ACCEPTED_EXTENSIONS,
        },
      ],
    });

    if (filePath) {
      transcribeFile(filePath);
    }
  }, [transcribeFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (ext && ACCEPTED_EXTENSIONS.includes(ext)) {
          const filePath = (file as any).path;
          if (filePath) {
            transcribeFile(filePath);
          } else {
            toast.error(t("audioTranscribe.dropNotSupported"));
          }
        } else {
          toast.error(t("audioTranscribe.unsupportedFormat"));
        }
      }
    },
    [transcribeFile, t],
  );

  const handleCopy = useCallback(() => {
    if (result) {
      navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [result]);

  const getStatusText = () => {
    switch (status) {
      case "loading":
        return t("audioTranscribe.status.loading");
      case "loading_model":
        return t("audioTranscribe.status.loadingModel");
      case "transcribing":
        return t("audioTranscribe.status.transcribing");
      default:
        return "";
    }
  };

  const isProcessing =
    status === "loading" ||
    status === "loading_model" ||
    status === "transcribing";

  // Detect if text is primarily RTL (Arabic, Hebrew, etc.)
  const isRTLText = (text: string) => {
    const rtlChars = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/;
    const matches = text.match(new RegExp(rtlChars.source, "g"));
    return matches && matches.length > text.length * 0.3;
  };

  return (
    <div className="flex flex-col gap-4 w-full max-w-md flex-1">
      <SettingsGroup title={t("audioTranscribe.title")}>
        <div className="flex flex-col gap-3 p-3">
          {/* Drop zone */}
          <div
            ref={dropRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={!isProcessing ? handleFileSelect : undefined}
            className={`
              flex flex-col items-center justify-center gap-3 p-6
              border-2 border-dashed rounded-lg cursor-pointer
              transition-all duration-200
              ${
                isDragging
                  ? "border-logo-primary bg-logo-primary/10"
                  : "border-mid-gray/30 hover:border-mid-gray/50 hover:bg-mid-gray/5"
              }
              ${isProcessing ? "pointer-events-none opacity-60" : ""}
            `}
          >
            {isProcessing ? (
              <>
                <div className="w-6 h-6 border-2 border-logo-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-mid-gray">{getStatusText()}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-mid-gray">
                  <Upload size={20} />
                  <FileAudio size={20} />
                </div>
                <p className="text-sm text-mid-gray text-center">
                  {t("audioTranscribe.dropzone")}
                </p>
                <p className="text-xs text-mid-gray/60">
                  WAV, MP3, FLAC, OGG, AAC
                </p>
              </>
            )}
          </div>

          {/* Result */}
          {result && (
            <div className="flex flex-col gap-2">
              {fileName && (
                <div className="flex items-center gap-2 text-xs text-mid-gray">
                  <FileAudio size={14} />
                  <span className="truncate">{fileName}</span>
                </div>
              )}
              <div className="relative">
                <div
                  dir={isRTLText(result) ? "rtl" : "ltr"}
                  className="bg-mid-gray/10 rounded-lg p-3 text-sm overflow-y-auto leading-relaxed whitespace-pre-wrap"
                >
                  {result}
                </div>
                <button
                  onClick={handleCopy}
                  className="absolute top-2 end-2 p-1.5 rounded-md bg-background/80 hover:bg-mid-gray/20 transition-colors"
                  title={t("settings.history.copyToClipboard")}
                >
                  {copied ? (
                    <Check size={14} className="text-green-500" />
                  ) : (
                    <Copy size={14} className="text-mid-gray" />
                  )}
                </button>
              </div>

              {/* Format button */}
              <button
                onClick={handleFormatText}
                disabled={isFormatting}
                className={`
                  flex items-center justify-center gap-2 px-3 py-2
                  rounded-lg text-sm font-medium transition-all duration-200
                  ${
                    isFormatting
                      ? "bg-mid-gray/20 text-mid-gray cursor-not-allowed"
                      : "bg-logo-primary/10 text-logo-primary hover:bg-logo-primary/20 active:bg-logo-primary/30"
                  }
                `}
              >
                {isFormatting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Sparkles size={16} />
                )}
                {isFormatting
                  ? t("audioTranscribe.formatting")
                  : t("audioTranscribe.formatButton")}
              </button>
            </div>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
};
