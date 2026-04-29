/**
 * Performance monitoring utilities for NotFlux frontend.
 * Logs performance metrics to console in development mode.
 */

/**
 * Mark the start of a performance measurement.
 */
export function markStart(label: string): void {
  if (import.meta.env.DEV) {
    performance.mark(`${label}-start`);
  }
}

/**
 * Mark the end of a performance measurement and log the duration.
 */
export function markEnd(label: string): void {
  if (import.meta.env.DEV) {
    performance.mark(`${label}-end`);
    try {
      performance.measure(label, `${label}-start`, `${label}-end`);
      const measure = performance.getEntriesByName(label, 'measure')[0];
      if (measure) {
        console.log(`⏱️ ${label}: ${measure.duration.toFixed(2)}ms`);
      }
    } catch (e) {
      // Ignore if marks don't exist
    }
  }
}

/**
 * Log the First Contentful Paint (FCP) time.
 */
export function logFCP(): void {
  if (import.meta.env.DEV && 'PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            console.log(`🎨 First Contentful Paint: ${entry.startTime.toFixed(2)}ms`);
            observer.disconnect();
          }
        }
      });
      observer.observe({ type: 'paint', buffered: true });
    } catch (e) {
      // Browser doesn't support PerformanceObserver
    }
  }
}

/**
 * Log Time to Interactive (TTI) estimation.
 */
export function logTTI(): void {
  if (import.meta.env.DEV) {
    window.addEventListener('load', () => {
      setTimeout(() => {
        const timing = performance.timing;
        const tti = timing.domInteractive - timing.navigationStart;
        console.log(`⚡ Time to Interactive: ${tti}ms`);
      }, 0);
    });
  }
}

/**
 * Initialize performance monitoring.
 * Call this once in your main.tsx file.
 */
export function initPerformanceMonitoring(): void {
  if (import.meta.env.DEV) {
    console.log('🚀 NotFlux Performance Monitoring Enabled');
    logFCP();
    logTTI();
  }
}
