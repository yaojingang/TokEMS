import { PARTNER_POSTER_DEFAULT_COPY } from '@conference/contracts';
import { attendeeAvatarInitial } from './attendee-poster';

export type PersonalPosterContent = {
  invitation?: string | null;
  callToAction?: string | null;
  scanHint?: string | null;
  displayName: string | null;
  company: string | null;
  title: string | null;
  industryLabel: string | null;
  businessIntro: string | null;
  avatarUrl: string | null;
};
export type PersonalPosterOptions = {
  variant: 'attendee' | 'partner';
  eventName: string;
  eventMark: string;
  eventLine: string;
  location: string;
  sequence?: number | null;
  content: PersonalPosterContent;
};

const renderVersions = new WeakMap<HTMLCanvasElement, number>();

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.closePath();
}

function drawPosterGrid(context: CanvasRenderingContext2D) {
  context.save();
  context.strokeStyle = 'rgba(138, 162, 210, 0.09)';
  context.lineWidth = 1;
  for (let x = 72; x <= 1008; x += 156) {
    context.beginPath();
    context.moveTo(x, 64);
    context.lineTo(x, 1376);
    context.stroke();
  }
  for (let y = 96; y <= 1368; y += 112) {
    context.beginPath();
    context.moveTo(64, y);
    context.lineTo(1016, y);
    context.stroke();
  }
  context.restore();
}

function drawPill(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { background: string; color: string; font?: string },
) {
  context.font = options.font ?? '700 20px "Arial Narrow", "PingFang SC", sans-serif';
  const characters = Array.from(text);
  while (characters.length > 1 && context.measureText(characters.join('')).width > 566)
    characters.pop();
  text = characters.join('');
  const width = Math.ceil(context.measureText(text).width) + 44;
  context.fillStyle = options.background;
  roundedRect(context, x, y, width, 48, 24);
  context.fill();
  context.fillStyle = options.color;
  context.fillText(text, x + 22, y + 31);
  return width;
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const characters = Array.from(text);
  let line = '';
  let truncated = false;
  const lines: string[] = [];
  for (const character of characters) {
    const candidate = `${line}${character}`;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = character;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (!truncated && lines.length > 1 && Array.from(lines.at(-1)!).length < 4) {
    const previous = Array.from(lines[lines.length - 2]!);
    if (previous.length > 6) {
      lines[lines.length - 1] = previous.splice(-3).join('') + lines[lines.length - 1];
      lines[lines.length - 2] = previous.join('');
    }
  }
  lines.slice(0, maxLines).forEach((value, index) => {
    const finalValue = truncated && index === maxLines - 1 ? `${value.slice(0, -1)}…` : value;
    context.fillText(finalValue, x, y + index * lineHeight);
  });
  return lines.length;
}

async function drawAvatar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  content: PersonalPosterContent,
  variant: PersonalPosterOptions['variant'],
) {
  const avatarUrl = content.avatarUrl;
  if (avatarUrl) {
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          image.onload = null;
          image.onerror = null;
          reject(new Error('avatar load timed out'));
        }, 5000);
        image.onload = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        image.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('avatar load failed'));
        };
        image.src = avatarUrl;
      });
      context.save();
      roundedRect(context, x, y, size, size, 26);
      context.clip();
      context.drawImage(image, x, y, size, size);
      context.restore();
      context.strokeStyle = 'rgba(245, 247, 250, 0.22)';
      context.lineWidth = 2;
      roundedRect(context, x, y, size, size, 26);
      context.stroke();
      return;
    } catch {
      // The initials treatment keeps poster export available when image CORS is unavailable.
    }
  }
  context.fillStyle = '#142443';
  roundedRect(context, x, y, size, size, 26);
  context.fill();
  context.strokeStyle = 'rgba(76, 121, 255, 0.62)';
  context.lineWidth = 2;
  roundedRect(context, x, y, size, size, 26);
  context.stroke();
  context.fillStyle = '#f3f5f8';
  context.font = '800 82px "Arial Narrow", "PingFang SC", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(
    attendeeAvatarInitial(content.displayName || (variant === 'partner' ? '合作伙伴' : null)),
    x + size / 2,
    y + size / 2,
  );
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

/** Both account surfaces use this 1080 × 1440 composition for preview and export. */
export async function renderPersonalEventPoster(
  target: HTMLCanvasElement,
  qrCanvas: HTMLCanvasElement,
  options: PersonalPosterOptions,
): Promise<boolean> {
  const version = (renderVersions.get(target) ?? 0) + 1;
  renderVersions.set(target, version);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1440;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器暂不支持海报生成，请更换浏览器重试');
  const isPartner = options.variant === 'partner';
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#07111f';
  context.fillRect(0, 0, 1080, 1440);
  drawPosterGrid(context);

  context.fillStyle = '#c9ff5a';
  context.fillRect(72, 72, 14, 14);
  context.fillStyle = '#9eabc0';
  context.font = '700 20px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText(isPartner ? 'EVENT PARTNER' : 'CONFIRMED ATTENDEE', 104, 86);
  context.textAlign = 'right';
  context.fillText(
    `${isPartner ? 'PARTNER' : `NO.${String(options.sequence ?? 1).padStart(3, '0')}`}  /  ${options.location}`,
    1008,
    86,
  );
  context.textAlign = 'left';

  context.fillStyle = '#f3f5f8';
  context.font = '800 54px "Arial Narrow", "PingFang SC", sans-serif';
  const eventTitleLines = wrapText(context, options.eventName, 72, 174, 760, 64, 2);
  context.fillStyle = '#8fa1bf';
  context.font = '600 22px "Arial Narrow", "PingFang SC", sans-serif';
  wrapText(
    context,
    `${options.eventMark}  /  ${options.eventLine}`,
    72,
    Math.max(258, 174 + (eventTitleLines - 1) * 64 + 42),
    936,
    30,
    1,
  );

  context.fillStyle = '#c9ff5a';
  context.font = '800 20px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText(
    isPartner ? 'INVITATION  /  大会合作伙伴' : 'I AM ATTENDING  /  已确认参会',
    72,
    430,
  );
  const displayName = options.content.displayName || (isPartner ? '大会合作伙伴' : '大会报名会员');
  const displayNameLength = Array.from(displayName).length;
  const displayNameSize =
    displayNameLength <= 4 ? 92 : displayNameLength <= 6 ? 76 : displayNameLength <= 9 ? 62 : 54;
  context.fillStyle = '#f3f5f8';
  context.font = `900 ${displayNameSize}px "Arial Narrow", "PingFang SC", sans-serif`;
  wrapText(context, displayName, 72, 548, 610, displayNameSize + 14, 2);
  context.fillStyle = '#b8c2d3';
  context.font = '600 29px "Arial Narrow", "PingFang SC", sans-serif';
  const identity =
    [options.content.company, options.content.title].filter(Boolean).join('  /  ') ||
    (isPartner ? '' : '期待在大会现场与你见面');
  wrapText(context, identity, 72, isPartner ? 700 : 750, 610, isPartner ? 32 : 44, 2);
  if (isPartner) {
    context.font = '500 24px "PingFang SC", sans-serif';
    wrapText(context, options.content.invitation || PARTNER_POSTER_DEFAULT_COPY.invitation, 72, 780, 900, 30, 2);
  }
  await drawAvatar(context, 736, 412, 272, options.content, options.variant);

  const industry = options.content.industryLabel;
  if (industry) {
    drawPill(context, industry, 72, isPartner ? 864 : 824, {
      background: '#173266',
      color: '#dbe5ff',
    });
  }

  context.strokeStyle = 'rgba(158, 171, 192, 0.3)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(72, 922);
  context.lineTo(1008, 922);
  context.stroke();
  context.fillStyle = '#4c79ff';
  context.font = '800 18px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('LOOKING TO CONNECT  /  我在做的事', 72, 980);
  context.fillStyle = '#eef2f8';
  context.font = `650 ${isPartner && Array.from(options.content.businessIntro || '').length > 50 ? 24 : 33}px "Arial Narrow", "PingFang SC", sans-serif`;
  wrapText(
    context,
    options.content.businessIntro || '正在寻找行业伙伴、业务交流与新的合作机会。',
    72,
    1040,
    650,
    50,
    3,
  );

  context.fillStyle = '#f3f5f8';
  roundedRect(context, 780, 1088, 228, 228, 18);
  context.fill();
  context.drawImage(qrCanvas, 798, 1106, 192, 192);
  context.fillStyle = '#c9ff5a';
  context.font = '800 19px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('SCAN TO CONNECT', 72, 1236);
  context.fillStyle = '#f3f5f8';
  context.font = '700 28px "Arial Narrow", "PingFang SC", sans-serif';
  wrapText(context, isPartner ? options.content.callToAction || PARTNER_POSTER_DEFAULT_COPY.callToAction : '现场见，一起聊聊', 72, 1282, 650, 32, 1);
  context.fillStyle = '#8fa1bf';
  context.font = '500 19px "Arial Narrow", "PingFang SC", sans-serif';
  context.font = `500 ${isPartner && Array.from(options.content.scanHint || '').length > 26 ? 16 : 19}px "PingFang SC", sans-serif`;
  context.fillText(
    isPartner ? options.content.scanHint || PARTNER_POSTER_DEFAULT_COPY.scanHint : '扫码查看大会信息与我的参会名片',
    72,
    1321,
  );

  context.fillStyle = '#4c79ff';
  context.fillRect(72, 1362, 72, 6);
  context.fillStyle = '#7e8da6';
  context.font = '600 17px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText(
    `${options.eventMark}  ·  ${isPartner ? 'PARTNER PASS' : 'MEMBER PASS'}`,
    168,
    1370,
  );

  if (renderVersions.get(target) !== version) return false;
  const destination = target.getContext('2d');
  if (!destination) throw new Error('浏览器暂不支持海报生成，请更换浏览器重试');
  destination.clearRect(0, 0, target.width, target.height);
  destination.drawImage(canvas, 0, 0, target.width, target.height);
  return true;
}
