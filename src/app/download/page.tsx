"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Download, FileArchive, Loader2 } from "lucide-react"

export default function DownloadPage() {
  // Auto-start download after 2 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      window.location.href = "/api/download"
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-card/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 h-14 w-14 rounded-2xl bg-primary/15 flex items-center justify-center">
            <FileArchive className="h-7 w-7 text-primary" />
          </div>
          <CardTitle className="text-xl">Insight Replay — Project Source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>جاري تحميل الملف...</span>
            </div>
            <p className="text-xs text-muted-foreground">
              التحميل يبدأ تلقائياً خلال ثانيتين
            </p>
          </div>

          <div className="rounded-lg bg-background/40 border border-border/60 p-4 space-y-2 text-xs text-right">
            <div className="flex justify-between">
              <span className="text-muted-foreground">اسم الملف:</span>
              <span className="font-mono">insight-replay.zip</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">الحجم:</span>
              <span>4.7 MB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">عدد الملفات:</span>
              <span>863 ملف</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">الصيغة:</span>
              <span>ZIP (مضغوط)</span>
            </div>
          </div>

          <Button
            className="w-full gap-2"
            size="lg"
            onClick={() => (window.location.href = "/api/download")}
          >
            <Download className="h-4 w-4" />
            تحميل الآن
          </Button>

          <div className="pt-3 border-t border-border/40">
            <p className="text-[11px] text-muted-foreground mb-2">طريقة التشغيل بعد التحميل:</p>
            <pre className="text-[10px] text-left bg-background/60 rounded-md p-2 font-mono overflow-x-auto">
{`unzip insight-replay.zip -d insight-replay/
cd insight-replay/
bun install
cp .env.example .env
bun run db:push
bun run dev`}
            </pre>
          </div>

          <a
            href="/"
            className="inline-block text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
          >
            ← العودة للداشبورد
          </a>
        </CardContent>
      </Card>
    </div>
  )
}
