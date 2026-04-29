/** Skeleton loading placeholder for MediaCard */
export default function MediaCardSkeleton() {
  return (
    <div className="relative rounded-xl overflow-hidden bg-bg-card aspect-video w-full animate-fade-in">
      {/* Thumbnail skeleton */}
      <div className="absolute inset-0 skeleton" />
      
      {/* Bottom info skeleton */}
      <div className="absolute bottom-0 inset-x-0 p-3 bg-gradient-to-t from-black/80 via-black/30 to-transparent space-y-2">
        <div className="h-3 bg-white/20 rounded w-3/4 skeleton" />
        <div className="h-2.5 bg-white/10 rounded w-1/2 skeleton" />
      </div>
      
      {/* Rating badge skeleton */}
      <div className="absolute top-2 right-2 h-5 w-10 rounded bg-white/20 skeleton" />
    </div>
  );
}
