import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard · MapForge',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'studio',
    title: 'Mapping Studio · MapForge',
    loadComponent: () =>
      import('./features/mapping-studio/mapping-studio.component').then(
        (m) => m.MappingStudioComponent,
      ),
  },
  {
    path: 'transformations',
    title: 'Transformations · MapForge',
    loadComponent: () =>
      import('./features/transformations/transformations.component').then(
        (m) => m.TransformationsComponent,
      ),
  },
  {
    path: 'code',
    title: 'Code Generator · MapForge',
    loadComponent: () =>
      import('./features/code-generator/code-generator.component').then(
        (m) => m.CodeGeneratorComponent,
      ),
  },
  {
    path: 'examples',
    title: 'Examples · MapForge',
    loadComponent: () =>
      import('./features/examples/examples.component').then((m) => m.ExamplesComponent),
  },
  {
    path: 'projects',
    title: 'Saved Projects · MapForge',
    loadComponent: () =>
      import('./features/saved-projects/saved-projects.component').then(
        (m) => m.SavedProjectsComponent,
      ),
  },
  {
    path: 'settings',
    title: 'Settings · MapForge',
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
  },
  { path: '**', redirectTo: 'dashboard' },
];
