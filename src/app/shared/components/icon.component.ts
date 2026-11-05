import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Ícones em SVG inline: nada é baixado de fora. Cada entrada é uma lista de caminhos. */
const ICONS: Record<string, string[]> = {
  dashboard: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  studio: [
    'M5 6a2 2 0 1 0 0-.01',
    'M5 18a2 2 0 1 0 0-.01',
    'M19 12a2 2 0 1 0 0-.01',
    'M7 6c6 0 4 6 10 6',
    'M7 18c6 0 4-6 10-6',
  ],
  transform: ['M4 7h12', 'M12 3l4 4-4 4', 'M20 17H8', 'M12 13l-4 4 4 4'],
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M14 4l-4 16'],
  examples: [
    'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    'M8 8h8',
    'M8 12h8',
    'M8 16h5',
  ],
  folder: ['M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M16 5v4', 'M8 15v4'],
  plus: ['M12 5v14', 'M5 12h14'],
  save: [
    'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M7 3v6h8V3',
    'M7 21v-7h10v7',
  ],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 20h16'],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  sun: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'M12 2v2',
    'M12 20v2',
    'M4 12H2',
    'M22 12h-2',
    'M5 5l1.5 1.5',
    'M17.5 17.5L19 19',
    'M5 19l1.5-1.5',
    'M17.5 6.5L19 5',
  ],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z'],
  undo: ['M9 7L4 12l5 5', 'M4 12h11a5 5 0 0 1 0 10h-3'],
  redo: ['M15 7l5 5-5 5', 'M20 12H9a5 5 0 0 0 0 10h3'],
  play: ['M7 4l13 8-13 8z'],
  check: ['M4 12l5 5L20 6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  star: ['M12 3l2.7 5.6 6.1.8-4.5 4.2 1.2 6.1L12 16.8 6.5 19.7l1.2-6.1L3.2 9.4l6.1-.8z'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronDown: ['M6 9l6 6 6-6'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-5-5'],
  zoomIn: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-5-5', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-5-5', 'M8 11h6'],
  fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  reset: ['M4 12a8 8 0 1 0 2.5-5.8', 'M4 4v4h4'],
  wand: ['M5 19L16 8', 'M14 6l4 4', 'M19 3v3', 'M21 5h-3', 'M6 4v2', 'M7 5H5'],
  warning: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17v.01'],
  error: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8v5', 'M12 16v.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 8v.01'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  history: ['M4 12a8 8 0 1 0 2.5-5.8', 'M4 4v4h4', 'M12 8v4l3 2'],
  grip: ['M9 6v.01', 'M15 6v.01', 'M9 12v.01', 'M15 12v.01', 'M9 18v.01', 'M15 18v.01'],
  format: ['M4 6h16', 'M4 12h10', 'M4 18h13'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  keyboard: ['M3 7h18v10H3z', 'M7 11h.01', 'M11 11h.01', 'M15 11h.01', 'M8 14h8'],
};

@Component({
  selector: 'mf-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      @for (d of paths(); track d) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<string>();
  readonly size = input(16);
  protected readonly paths = computed(() => ICONS[this.name()] ?? []);
}
