const {
  findDriveFile,
  readDriveFileContent,
  copyToMobiusFolder,
  createDriveFile,
  writeDriveFileContent,
  updateOriginalFile
} = require('../../google_api.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;
  const { userId, filename, content, fileId, mimeType, folderId, originalFileId } = req.body || {};

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    switch (action) {
      case 'find': {
        if (!filename) return res.status(400).json({ error: 'filename required' });
        const result = await findDriveFile(userId, filename);
        return res.json(result);
      }
      case 'read': {
        if (!fileId) return res.status(400).json({ error: 'fileId required' });
        const result = await readDriveFileContent(userId, fileId, mimeType || 'text/plain');
        return res.json({ content: result });
      }
      case 'copy': {
        if (!fileId) return res.status(400).json({ error: 'fileId required' });
        const result = await copyToMobiusFolder(userId, fileId, mimeType, filename, folderId);
        return res.json({ copy: result });
      }
      case 'create': {
        if (!filename) return res.status(400).json({ error: 'filename required' });
        const result = await createDriveFile(userId, filename, folderId);
        return res.json({ file: result });
      }
      case 'append': {
        if (!fileId || !content) return res.status(400).json({ error: 'fileId and content required' });
        await writeDriveFileContent(userId, fileId, content);
        return res.json({ ok: true });
      }
      case 'update-original': {
        if (!originalFileId) return res.status(400).json({ error: 'originalFileId required' });
        await updateOriginalFile(userId, originalFileId, content);
        return res.json({ ok: true });
      }
      default:
        return res.status(400).json({ error: 'Invalid action: ' + action });
    }
  } catch (err) {
    console.error('Focus action error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
