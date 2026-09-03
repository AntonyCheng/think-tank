import {
  CloseOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LinkOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Button, Input } from "antd";

export type ResearchSourceKind = "web" | "urls" | "urls_web" | "local" | "hybrid";

export interface ResearchSourceConfig {
  kind: ResearchSourceKind;
  urls: string;
  files: File[];
  includeDomains: string;
  excludeDomains: string;
}

export const sourceLabels: Record<ResearchSourceKind, string> = {
  web: "Web 搜索",
  urls: "仅指定 URL",
  urls_web: "指定 URL + Web 补充",
  local: "本地文档",
  hybrid: "本地文档 + Web",
};

const sourceChoices: Array<{
  kind: ResearchSourceKind;
  description: string;
  icon: typeof GlobalOutlined;
}> = [
  { kind: "web", description: "联网检索公开可验证资料", icon: GlobalOutlined },
  { kind: "urls", description: "只研究你提供的网页地址", icon: LinkOutlined },
  { kind: "urls_web", description: "以指定网址为主并补充检索", icon: LinkOutlined },
  { kind: "local", description: "仅依据上传的本地资料", icon: FileTextOutlined },
  { kind: "hybrid", description: "本地资料结合联网检索", icon: FileTextOutlined },
];

function usesUrls(kind: ResearchSourceKind): boolean {
  return kind === "urls" || kind === "urls_web";
}

function usesFiles(kind: ResearchSourceKind): boolean {
  return kind === "local" || kind === "hybrid";
}

function usesWeb(kind: ResearchSourceKind): boolean {
  return kind === "web" || kind === "urls_web" || kind === "hybrid";
}

export function ResearchSourcePopover({
  value,
  onChange,
}: {
  value: ResearchSourceConfig;
  onChange: (value: ResearchSourceConfig) => void;
}) {
  const update = (patch: Partial<ResearchSourceConfig>) => onChange({ ...value, ...patch });
  return (
    <section
      aria-label="研究来源设置"
      className="research-source-popover"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="research-source-heading">
        <div><strong>研究来源</strong><span>选择本次研究可使用的资料范围</span></div>
      </div>
      <div className="source-mode-list" role="radiogroup" aria-label="来源方式">
        {sourceChoices.map((choice) => {
          const Icon = choice.icon;
          const selected = value.kind === choice.kind;
          return <button aria-checked={selected} className={`source-mode-choice ${selected ? "is-selected" : ""}`} key={choice.kind} onClick={() => update({ kind: choice.kind })} role="radio" type="button"><Icon /><span><strong>{sourceLabels[choice.kind]}</strong><small>{choice.description}</small></span></button>;
        })}
      </div>
      {usesUrls(value.kind) && <label className="source-field"><span>指定 URL</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event) => update({ urls: event.target.value })} placeholder="每行一个 https:// 地址" value={value.urls} /></label>}
      {usesFiles(value.kind) && <section className="source-files"><div><span>本地文档</span><small>支持 PDF / Word / PPT / Excel / CSV / TXT / Markdown，最多 20 个文件，单个不超过 25 MiB</small></div><label className="source-file-picker"><PlusOutlined />添加文件<input accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.markdown" multiple onChange={(event) => update({ files: Array.from(event.target.files ?? []) })} type="file" /></label>{value.files.length > 0 && <div className="source-file-list">{value.files.map((file, index) => <span key={`${file.name}-${file.lastModified}`} title={file.name}>{file.name}<Button aria-label={`移除文件：${file.name}`} icon={<CloseOutlined />} onClick={() => update({ files: value.files.filter((_item, fileIndex) => fileIndex !== index) })} size="small" type="text" /></span>)}</div>}</section>}
      {usesWeb(value.kind) && <div className="source-domain-fields"><label className="source-field"><span>限定网站（可选）</span><Input onChange={(event) => update({ includeDomains: event.target.value })} placeholder="例如 stats.gov.cn, imf.org" value={value.includeDomains} /></label><label className="source-field"><span>排除网站（可选）</span><Input onChange={(event) => update({ excludeDomains: event.target.value })} placeholder="例如 example.com" value={value.excludeDomains} /></label></div>}
    </section>
  );
}
