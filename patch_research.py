"""
Run this script in your Papyrates project folder (where research.html lives).
It patches research.html to use the shared auth system instead of its own login.
Usage: python patch_research.py
"""
import re, shutil, os

path = 'research.html'
if not os.path.exists(path):
    print("ERROR: research.html not found. Run this from your project folder.")
    exit(1)

shutil.copy(path, 'research.html.bak')
print("Backup saved as research.html.bak")

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove the login-screen div
content = re.sub(
    r'\n<div id="login-screen">.*?</div>\n',
    '\n',
    content, flags=re.DOTALL
)

# 2. Show main-app immediately
content = content.replace(
    'id="main-app" style="display:none;flex-direction:column;min-height:100vh;"',
    'id="main-app" style="display:flex;flex-direction:column;min-height:100vh;"'
)

# 3. Remove doLogin function and event listeners
content = re.sub(
    r"\ndocument\.getElementById\(\"login-btn-r\"\)\.addEventListener.*?function doLogin\(\)\{.*?\}\n",
    '\n',
    content, flags=re.DOTALL
)

# 4. Add auth check before </body>
auth_snippet = '''<script src="/papyrates-auth.js"></script>
<script>
  // Only admins can access research portals
  requireAuth('admin');
</script>
'''
content = content.replace('</body>', auth_snippet + '</body>')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("research.html patched successfully.")
print("Test it locally, then deploy to Vercel.")
