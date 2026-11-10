# Qwen3-VL 提示词生成（点击生成）：根据一段引导语（主题）生成图生视频提示词。
# 用法：python qwen3vl_prompt.py <引导语> [模型目录]
# 输出：仅把生成的提示词打印到 stdout（其余日志走 stderr）。
import sys
import os

# Windows 下 Python 管道输出默认用 GBK，Node 端按 UTF-8 解码会乱码 → 强制 stdout/stderr 输出 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def main():
    if len(sys.argv) < 2:
        log("用法: qwen3vl_prompt.py <引导语> [模型目录]")
        sys.exit(2)
    guide = sys.argv[1].strip()
    if not guide:
        log("引导语为空"); sys.exit(2)
    model_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', '..', 'qwen3-vl-2b')
    model_dir = os.path.abspath(model_dir)
    if not os.path.exists(os.path.join(model_dir, 'config.json')):
        log("模型目录不存在或缺少 config.json:", model_dir); sys.exit(2)

    try:
        import torch
        from transformers import Qwen3VLForConditionalGeneration, Qwen3VLProcessor
    except Exception as e:
        log("缺少依赖:", e); sys.exit(2)

    log("加载模型:", model_dir)
    try:
        model = Qwen3VLForConditionalGeneration.from_pretrained(
            model_dir, dtype="auto", device_map="auto", low_cpu_mem_usage=True,
        )
        processor = Qwen3VLProcessor.from_pretrained(model_dir)
    except Exception as e:
        log("模型加载失败:", e); sys.exit(2)

    # 与原系统一致：引导语作为「主题」拼进固定指令，纯文本生成（不传图片）
    text = f"我需要根据图片生成视频，帮我生成一段连贯的提示词，主题是{guide}"
    messages = [
        {"role": "system", "content": [{"type": "text", "text": "你是一个图生视频提示词助手，只输出一条提示词本身，不要任何解释、标题或 markdown。"}]},
        {"role": "user", "content": [{"type": "text", "text": text}]},
    ]

    log("编码输入…")
    try:
        inputs = processor.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True,
            return_dict=True, return_tensors="pt",
        )
        inputs = inputs.to(model.device)
    except Exception as e:
        log("输入编码失败:", e); sys.exit(2)

    log("推理…")
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=256, do_sample=True, temperature=0.7, top_p=0.9)
    prompt = processor.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip()
    if not prompt:
        log("模型未产出提示词"); sys.exit(2)
    print(prompt)
    sys.exit(0)

if __name__ == "__main__":
    main()
