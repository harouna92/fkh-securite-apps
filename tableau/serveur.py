# -*- coding: utf-8 -*-
"""Serveur du tableau de bord (b261).

Pourquoi celui-ci et pas `python -m http.server` : le serveur standard ne sait que LIRE. Or Zeus veut
faire glisser une carte d'un etat a l'autre et que ce deplacement soit reellement pris en compte —
donc ecrit dans etats.json, pas seulement affiche. Ce serveur ajoute une seule chose : accepter
POST /tableau/etats.json et enregistrer le fichier. Rien d'autre n'est ouvert, et il n'ecoute que sur
127.0.0.1 : il n'est pas joignable depuis l'exterieur.
"""
import io, json, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RACINE = r'C:\Users\Utilisateur\fkh-web'
FICHIER = os.path.join(RACINE, 'tableau', 'etats.json')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=RACINE, **k)

    def log_message(self, *a):
        pass  # silence : les logs polluent la sortie sans rien apprendre

    def do_GET(self):
        # Ce serveur est CELUI du tableau de bord : ouvrir la racine doit donner le tableau,
        # pas la page des applications. Sans ca, cliquer sur « localhost:8150 » tombe a cote.
        if self.path.split('?')[0] in ('/', ''):
            self.send_response(302)
            self.send_header('Location', '/tableau/')
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] != '/tableau/etats.json':
            self.send_error(404)
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            brut = self.rfile.read(n).decode('utf-8')
            data = json.loads(brut)          # on valide avant d'ecrire : jamais de fichier casse
            assert isinstance(data, dict) and 'items' in data
            with io.open(FICHIER, 'w', encoding='utf-8') as f:
                f.write(json.dumps(data, indent=2, ensure_ascii=False))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as e:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': False, 'err': str(e)}).encode('utf-8'))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8150
    print('tableau de bord : http://localhost:%d/tableau/ (ecriture activee)' % port)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
