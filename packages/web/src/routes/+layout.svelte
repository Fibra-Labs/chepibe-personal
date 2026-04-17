<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import type { LayoutData } from './$types';

	let { children, data }: { children: any; data: LayoutData } = $props();
</script>

<div class="relative min-h-screen overflow-x-hidden" style="background: var(--background);">
	<!-- Ambient Background Orbs -->
	<div class="ambient-orb orb-1 animate-float"></div>
	<div class="ambient-orb orb-2 animate-float" style="animation-delay: -10s;"></div>

	<!-- Navigation -->
	<nav class="fixed top-0 left-0 right-0 z-50 border-b transition-all duration-300" 
	     style="background: rgba(250, 250, 249, 0.85); border-color: var(--card-border); backdrop-filter: blur(20px);">
		<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
			<div class="flex h-16 justify-between items-center">
				<div class="flex items-center gap-2">
					<a href="/" class="font-display text-xl font-bold" style="color: var(--foreground);">
						<span style="color: var(--primary);">Che</span> Pibe
					</a>
					<span class="rounded-full px-2 py-0.5 text-xs font-medium" 
					      style="background: var(--accent-glow); color: var(--accent-dark);">
						Personal
					</span>
				</div>
				<div class="flex items-center gap-6">
					<a href="/" 
					   class="nav-link text-sm {$page.url.pathname === '/' ? 'active' : ''}">
						Panel
					</a>
					<a href="/qr" 
					   class="nav-link text-sm {$page.url.pathname === '/qr' ? 'active' : ''}">
						QR
					</a>
				</div>
			</div>
		</div>
	</nav>

	<!-- Main Content -->
	<main class="relative mx-auto max-w-7xl px-4 pt-24 pb-8 sm:px-6 lg:px-8">
		{@render children()}
	</main>

	<!-- Footer with Allowed Phone -->
	{#if data.allowedPhone}
		<footer class="fixed bottom-4 right-4 z-50">
			<div class="glass-card px-4 py-2 text-sm flex items-center gap-2">
				<span style="color: var(--foreground-muted);">📱</span>
				<span style="color: var(--foreground-muted);">Configurado para:</span>
				<span class="font-semibold" style="color: var(--primary);">+{data.allowedPhone}</span>
			</div>
		</footer>
	{/if}
</div>
