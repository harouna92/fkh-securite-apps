# -*- coding: utf-8 -*-
"""Serveur local pour vérifier les cockpits avant de pousser.

POURQUOI — 2026-08-12. `python -m http.server` tronquait les réponses au-delà de
~780 Ko : le cockpit FKH (792 Ko) arrivait incomplet, la page restait bloquée à 31
iframes sur 33 et `curl` rendait l'erreur 56 après 783 360 octets. Sans serveur
fiable, impossible de vérifier une modification avant de la mettre en ligne — et
pousser sans vérifier est exactement ce qui a coûté la journée (G-65).

Ce qu'il fait de plus que le module standard :
  - HTTP/1.1 avec Content-Length exact, et écriture par blocs de 64 Ko avec flush,
    au lieu d'un copyfileobj qui rend la main avant que tout soit parti ;
  - un thread par requête (ThreadingHTTPServer) et daemon_threads, pour qu'un fetch
    lancé par la page pendant que le HTML est encore en cours de transfert ne reste
    pas en file derrière lui ;
  - `Cache-Control: no-store` : en vérification, une page servie depuis le cache du
    navigateur ne prouve rien ;
  - il refuse de démarrer si le port est déjà pris, plutôt que de laisser deux
    serveurs se disputer les connexions — c'est une cause de coupure silencieuse.

Usage :  python serveur_local.py [port] [racine]
"""
import os
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8161
RACINE = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
BLOC = 64 * 1024


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "fkh-verif/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=RACINE, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def copyfile(self, source, outputfile):
        """Écrit par blocs, en s'assurant que chaque bloc est bien parti."""
        while True:
            bloc = source.read(BLOC)
            if not bloc:
                break
            outputfile.write(bloc)
        try:
            outputfile.flush()
        except Exception:
            pass

    def log_message(self, fmt, *args):
        # on ne garde que ce qui n'est pas un 200 : le bruit masque les vrais échecs
        code = args[1] if len(args) > 1 else ""
        if str(code) != "200":
            sys.stderr.write("%s %s\n" % (self.path, " ".join(str(x) for x in args)))


def port_libre(p):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p))
        return True
    except OSError:
        return False
    finally:
        s.close()


if not port_libre(PORT):
    print("❌ le port %d est déjà occupé — deux serveurs sur le même port se coupent" % PORT)
    print("   la parade : choisir un autre port, ou arrêter celui qui tourne.")
    sys.exit(1)

srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
srv.daemon_threads = True
srv.request_queue_size = 64
print("Serveur de vérification sur http://localhost:%d/  (racine : %s)" % (PORT, RACINE))
print("HTTP/1.1 · un thread par requête · pas de cache · blocs de %d Ko" % (BLOC // 1024))
srv.serve_forever()
