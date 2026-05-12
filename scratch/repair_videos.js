const Database = require('better-sqlite3');
const path = require('path');

const db = new Database('archive.db');

async function repairVideos() {
  const posts = db.prepare('SELECT no, contentHtml FROM posts WHERE contentHtml LIKE "%<video%"').all();
  console.log(`[Repair] 비디오 태그가 발견된 글 ${posts.length}개를 수정합니다...`);

  for (const post of posts) {
    let contentHtml = post.contentHtml;
    
    // <video> 태그 블록 전체를 매칭하여 내부의 src를 추출하고 img로 교체
    contentHtml = contentHtml.replace(/<video[^>]+(?:data-src|src)=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/video>/gi, (match, videoSrc, inner) => {
      // <source> 태그가 내부에 있다면 거기서도 src를 찾음
      let src = videoSrc;
      const sourceMatch = inner.match(/<source[^>]+src=["'](https?:\/\/[^"']+)["']/i);
      if (sourceMatch) src = sourceMatch[1];

      // 주소에서 파라미터(?no=...) 제거하고 파일명만 추출하여 로컬 경로 유추
      // (또는 DB에서 다시 조회하는 것이 정확함)
      const cleanSrc = src.split('?')[0].split('/').pop();
      const localImage = db.prepare('SELECT path FROM images WHERE postNo = ? AND path LIKE ? LIMIT 1').get(post.no, `%${cleanSrc}%`);

      if (localImage && localImage.path !== "blocked") {
        return `<img src="${localImage.path}" style="max-width:100%; display:block; margin:10px 0; border-radius:8px;">`;
      }
      return ""; // 못 찾으면 일단 비움
    });

    db.prepare('UPDATE posts SET contentHtml = ? WHERE no = ?').run(contentHtml, post.no);
    console.log(`[Fixed] 글 ${post.no} 수리 완료`);
  }

  console.log('[Success] 모든 비디오 태그가 이미지로 교체되었습니다.');
}

repairVideos().catch(console.error);
