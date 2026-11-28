export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor(totalSeconds % 3_600 / 60);
	const seconds = totalSeconds % 60;
	return hours ? `${hours}h ${minutes}m ${seconds}s` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
