// Parse a movie filename into a searchable title + year for autopilot. Pure —
// no DOM, unit-tested. Handles scene-release names (dots, tags, groups, year).
export function parseMovieName(filename) {
  let name = String(filename || '');
  name = name.replace(/\.[a-z0-9]{2,4}$/i, '');          // drop extension
  name = name.replace(/[._]+/g, ' ');                    // dots/underscores → spaces
  const yearMatch = name.match(/\b(19\d{2}|20\d{2})\b/); // first plausible year
  const year = yearMatch ? yearMatch[1] : null;
  if (yearMatch) name = name.slice(0, yearMatch.index);  // cut year + trailing tags
  name = name.replace(
    /\b(1080p|2160p|720p|480p|4k|x264|x265|h ?264|h ?265|hevc|xvid|divx|aac|ac3|dts|bluray|blu-ray|brrip|bdrip|webrip|web-?dl|hdrip|dvdrip|dvdscr|remux|proper|repack|extended|unrated|imax|remastered)\b/gi,
    ' '
  );
  name = name.replace(/[\[(][^\])]*[\])]/g, ' ');        // closed bracket groups
  name = name.replace(/[^\p{L}\p{N}]+$/u, '');           // trailing punctuation/space
  name = name.replace(/^[^\p{L}\p{N}]+/u, '');           // leading punctuation/space
  name = name.replace(/\s{2,}/g, ' ').trim();
  const title = name || 'Unknown';
  return { title, year, query: year ? `${title} (${year})` : title };
}
